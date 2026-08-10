// src/RapidSOS.swift
//
// The Boston Police feed, pulled straight into the relay.
//
// Boston Police is not on Broadcastify, so until now the only way to hear it
// was to leave a browser tab open on radio.rapidsos.com and tap the sound that
// application was making. That worked and it was miserable: a tab a person
// could close, a machine that could not be left alone, and a feed that went
// quiet roughly twice a day for reasons nobody could see from inside the app.
//
// The reason turns out to be plain. The page is handed a `bff-cookie` with a
// one hour life, the audio socket refuses to open without it, and nothing in a
// tab that has been sitting there since yesterday renews it. So the socket
// eventually closes and the feed dies silently. Every client of this protocol
// has to treat the cookie as perishable, which is what the timer below is for.
//
// The wire format, verified against the live service rather than guessed:
//
//   GET https://radio.rapidsos.com/boston        -> Set-Cookie: bff-cookie, Max-Age 3600
//   WSS https://radio.rapidsos.com/bff/ws/<id>   -> 101, with that cookie
//
//   text frames   JSON, {"action":"tx_start"|"tx_end", ...} around each transmission
//   binary frames 14 byte header, then one Opus packet, 16kHz mono
//
// The last two bytes of the header are a sequence counter. Nothing here reads
// it yet; it is noted because it is the thing to reach for if the audio ever
// starts arriving out of order.

import Foundation

enum RapidSOS {
    static let host = "radio.rapidsos.com"
    static let page = URL(string: "https://radio.rapidsos.com/boston")!

    /* The channels the City of Boston publishes. Kept here so the app can
       offer a menu rather than asking a newsroom to paste a 24 character id
       it has no way to check. Ids are stable; the list is worth re-checking
       against /bff/proxy/streamchannels if a channel ever goes missing.

       BPD SCAN is a server-side aggregate of the six district channels, which
       is why it is first: one feed carries the whole city. */
    static let channels: [(id: String, label: String)] = [
        ("689bb05ee75d9bc528e81c79", "BPD SCAN (all districts)"),
        ("67b4a918f07fc8198abc4299", "BPD CH 1 - Special Event"),
        ("67b4a94bf07fc8198abc429a", "BPD CH 2 - Area A, Downtown / East Boston"),
        ("67ffbacc750036ae85e7c395", "BPD CH 3 - Area B, Roxbury / Mattapan"),
        ("67ffbaf8cd281dea86c07f70", "BPD CH 4 - Area E, West Roxbury / Hyde Park"),
        ("67ffbb16cd281dea86c07f71", "BPD CH 5 - Area D, Back Bay / South End"),
        ("67ffbb30f14dc59c46716089", "BPD CH 6 - Area C, South Boston / Dorchester"),
    ]

    /* Accepts what a person is likely to have: a bare channel id, or the whole
       wss address copied out of a developer console. Anything else is left
       alone so a channel this list has never heard of still works. */
    static func channelID(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: "/bff/ws/") { return String(s[r.upperBound...]) }
        return s
    }

    static func socketURL(_ raw: String) -> URL? {
        let id = channelID(raw)
        guard !id.isEmpty else { return nil }
        return URL(string: "wss://\(host)/bff/ws/\(id)")
    }
}

/* One live channel. Shaped deliberately like RawStream in Capture.swift: it is
   started, it is drained by whoever wants audio, it reports failure in words,
   and it says when it is finished. The capture loop already knows how to
   supervise something with that shape, including the backoff, so this file
   does not get its own opinions about reconnecting. */
final class RapidSOSStream: NSObject {
    private let url: URL
    private let label: String
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var opus: OpusDecoder?

    private let lock = NSLock()
    private var pcm: [Int16] = []
    private var stopping = false
    private var _failure: String?
    private var _finished = false
    private var _txEnded = false
    private var lastAudio = Date()
    private var cookieAt = Date.distantPast

    /* The cookie lives an hour. Renewing it means a new socket, so the stream
       retires itself with ten minutes to spare and lets the supervisor bring
       it back with a fresh one. Ten minutes rather than one because a
       reconnect during a working fire should happen on our schedule, not on
       the exact minute the far end decides we are stale. */
    private static let cookieLife: TimeInterval = 50 * 60

    init(channel: String, label: String) {
        self.url = RapidSOS.socketURL(channel) ?? RapidSOS.page
        self.label = label
        super.init()
    }

    var failure: String? { lock.lock(); defer { lock.unlock() }; return _failure }
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return _finished }

    /* True once the far end has said a transmission ended. The capture loop
       uses it to cut a clip on the boundary the radio itself drew, which is
       the one thing this feed offers that a raw audio stream cannot: every
       segment is a whole transmission rather than a slice of the clock. */
    var transmissionEnded: Bool {
        lock.lock(); defer { lock.unlock() }
        let v = _txEnded; _txEnded = false; return v
    }

    /// Everything decoded since the last call.
    func take() -> [Int16] {
        lock.lock(); defer { lock.unlock() }
        let out = pcm; pcm.removeAll(keepingCapacity: true); return out
    }

    private func fail(_ why: String) {
        lock.lock()
        if _failure == nil { _failure = why }
        _finished = true
        lock.unlock()
    }

    func stop() {
        lock.lock(); stopping = true; lock.unlock()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    /* The cookie the socket will not open without. Fetched with an ephemeral
       session so this never shares a cookie jar with the Broadcastify sign in
       happening a few threads away; two feeds quietly overwriting each other's
       credentials is the kind of bug that only shows up under load. */
    private func fetchCookie() -> String? {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 20
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        let s = URLSession(configuration: cfg)

        var req = URLRequest(url: RapidSOS.page)
        req.setValue(HTTP.ua, forHTTPHeaderField: "User-Agent")

        var cookie: String?
        let sem = DispatchSemaphore(value: 0)
        let t = s.dataTask(with: req) { _, resp, _ in
            defer { sem.signal() }
            guard let http = resp as? HTTPURLResponse,
                  let fields = http.allHeaderFields as? [String: String] else { return }
            let jar = HTTPCookie.cookies(withResponseHeaderFields: fields, for: RapidSOS.page)
            let pairs = jar.map { "\($0.name)=\($0.value)" }
            if !pairs.isEmpty { cookie = pairs.joined(separator: "; ") }
        }
        t.resume()
        if sem.wait(timeout: .now() + 25) == .timedOut { t.cancel(); return nil }
        s.finishTasksAndInvalidate()
        return cookie
    }

    func start() {
        guard let dec = OpusDecoder() else { fail("the Opus decoder would not start"); return }
        opus = dec

        guard let cookie = fetchCookie() else {
            fail("could not get a listening cookie from radio.rapidsos.com")
            return
        }
        cookieAt = Date()

        var req = URLRequest(url: url)
        req.setValue(cookie, forHTTPHeaderField: "Cookie")
        req.setValue("https://\(RapidSOS.host)", forHTTPHeaderField: "Origin")
        req.setValue(HTTP.ua, forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 30

        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 0          // a quiet channel is not a dead one
        cfg.timeoutIntervalForResource = 0
        session = URLSession(configuration: cfg)
        task = session.webSocketTask(with: req)
        task?.resume()
        receive()
        ping()
    }

    /* Scanner channels are quiet for minutes at a time, and a socket with
       nothing on it looks identical to a socket that has died. The ping is
       what tells the two apart, and it also keeps whatever sits between here
       and Boston from reaping an idle connection. */
    private func ping() {
        guard !finished else { return }
        task?.sendPing { [weak self] err in
            guard let self else { return }
            if let err {
                self.fail("the radio socket stopped answering: \(err.localizedDescription)")
                return
            }
            if Date().timeIntervalSince(self.cookieAt) > RapidSOSStream.cookieLife {
                /* Not an error. The supervisor reconnects with a fresh cookie,
                   which is the whole cure for the feed dying twice a day. */
                self.lock.lock(); self._finished = true; self.lock.unlock()
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 20) { self.ping() }
        }
    }

    /* The 14 byte header is fixed width and the Opus packet follows it. Frames
       shorter than the header are not audio and are dropped rather than
       reasoned about. */
    private static let headerBytes = 14

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                self.lock.lock(); let quitting = self.stopping; self.lock.unlock()
                if !quitting { self.fail("the radio feed dropped: \(err.localizedDescription)") }
                else { self.lock.lock(); self._finished = true; self.lock.unlock() }
                return

            case .success(let msg):
                switch msg {
                case .data(let d):
                    if d.count > RapidSOSStream.headerBytes, let dec = self.opus {
                        let packet = d.subdata(in: RapidSOSStream.headerBytes..<d.count)
                        if let samples = dec.decode(packet) {
                            self.lock.lock()
                            self.pcm.append(contentsOf: samples)
                            self.lastAudio = Date()
                            self.lock.unlock()
                        }
                    }
                case .string(let s):
                    /* Only the boundary matters here. Everything else in these
                       messages describes the sending radio, which the newsroom
                       reads off the transcript rather than off the wire. */
                    if s.contains("\"tx_end\"") {
                        self.lock.lock(); self._txEnded = true; self.lock.unlock()
                    }
                @unknown default: break
                }
                self.receive()
            }
        }
    }
}
