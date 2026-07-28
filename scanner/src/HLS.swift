import Foundation

/* Broadcastify retired the static MP3 endpoint. The player now loads HLS from
   hls-oN.broadcastify.com with a short lived session token scraped from the
   feed page, and the segments are MPEG transport streams carrying MP3 audio.
   This file does the sign in, the token refresh, the playlist follow and the
   transport stream demux. */

// MARK: - blocking HTTP, safe because every caller is on its own worker thread

struct HTTPResult {
    var data: Data?
    var status = 0
    var error: Error?
}

enum HTTP {
    static let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

    static func run(_ request: URLRequest, session: URLSession, timeout: TimeInterval) -> HTTPResult {
        var req = request
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = timeout

        var out = HTTPResult()
        let sem = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: req) { d, resp, err in
            out.data = d
            out.status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            out.error = err
            sem.signal()
        }
        task.resume()
        if sem.wait(timeout: .now() + timeout + 5) == .timedOut {
            task.cancel()
            out.error = NSError(domain: "HTTP", code: -1001,
                                userInfo: [NSLocalizedDescriptionKey: "timed out"])
        }
        return out
    }

    static func get(_ url: URL, session: URLSession,
                    referer: String? = nil, timeout: TimeInterval = 20) -> HTTPResult {
        var r = URLRequest(url: url)
        r.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        if let ref = referer { r.setValue(ref, forHTTPHeaderField: "Referer") }
        return run(r, session: session, timeout: timeout)
    }

    static func post(_ url: URL, form: [String: String], session: URLSession,
                     referer: String? = nil, timeout: TimeInterval = 25) -> HTTPResult {
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        if let ref = referer { r.setValue(ref, forHTTPHeaderField: "Referer") }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let body = form.map { k, v -> String in
            let ek = k.addingPercentEncoding(withAllowedCharacters: allowed) ?? k
            let ev = v.addingPercentEncoding(withAllowedCharacters: allowed) ?? v
            return ek + "=" + ev
        }.joined(separator: "&")
        r.httpBody = Data(body.utf8)
        return run(r, session: session, timeout: timeout)
    }
}

// MARK: - MPEG transport stream demux

enum TS {
    /* stream_type values that carry audio we can hand to afconvert */
    static let audioTypes: [UInt8: String] = [0x03: "mp3", 0x04: "mp3",
                                              0x0F: "aac", 0x11: "aac"]

    /// Walks the PAT then the PMT to find the first audio elementary stream.
    static func audioStream(_ data: Data) -> (pid: Int, ext: String)? {
        let b = [UInt8](data)
        var pmts = Set<Int>()
        var i = 0
        while i + 188 <= b.count {
            let p = i
            i += 188
            if b[p] != 0x47 { continue }
            if (b[p + 1] >> 6) & 1 == 0 { continue }          // needs a section start
            let pid = (Int(b[p + 1] & 0x1F) << 8) | Int(b[p + 2])
            let afc = (b[p + 3] >> 4) & 0x3
            var q = p + 4
            if afc == 2 || afc == 3 { q += 1 + Int(b[p + 4]) }
            guard q < p + 188 else { continue }
            let s = q + 1 + Int(b[q])                          // skip the pointer field
            guard s + 12 < p + 188 else { continue }

            if pid == 0 {
                let slen = (Int(b[s + 1] & 0x0F) << 8) | Int(b[s + 2])
                let end = min(s + 3 + slen - 4, p + 188 - 4)
                var j = s + 8
                while j + 3 < end {
                    let program = (Int(b[j]) << 8) | Int(b[j + 1])
                    let ppid = (Int(b[j + 2] & 0x1F) << 8) | Int(b[j + 3])
                    if program != 0 { pmts.insert(ppid) }
                    j += 4
                }
            } else if pmts.contains(pid) {
                let slen = (Int(b[s + 1] & 0x0F) << 8) | Int(b[s + 2])
                let infoLen = (Int(b[s + 10] & 0x0F) << 8) | Int(b[s + 11])
                let end = min(s + 3 + slen - 4, p + 188 - 5)
                var j = s + 12 + infoLen
                while j + 4 < end {
                    let stype = b[j]
                    let epid = (Int(b[j + 1] & 0x1F) << 8) | Int(b[j + 2])
                    let esLen = (Int(b[j + 3] & 0x0F) << 8) | Int(b[j + 4])
                    if let ext = audioTypes[stype] { return (epid, ext) }
                    j += 5 + esLen
                }
            }
        }
        return nil
    }

    /// Strips TS and PES framing off one PID, leaving a raw MP3 or AAC stream.
    static func elementary(_ data: Data, pid target: Int) -> Data {
        let b = [UInt8](data)
        var out = Data()
        var pending: [UInt8] = []

        func flush() {
            if pending.count >= 9, pending[0] == 0, pending[1] == 0, pending[2] == 1 {
                let start = 9 + Int(pending[8])
                if start < pending.count { out.append(contentsOf: pending[start...]) }
            }
            pending.removeAll(keepingCapacity: true)
        }

        var i = 0
        while i + 188 <= b.count {
            let p = i
            i += 188
            if b[p] != 0x47 { continue }
            if (Int(b[p + 1] & 0x1F) << 8) | Int(b[p + 2]) != target { continue }
            let afc = (b[p + 3] >> 4) & 0x3
            var q = p + 4
            if afc == 2 || afc == 3 { q += 1 + Int(b[p + 4]) }
            guard q < p + 188 else { continue }
            if (b[p + 1] >> 6) & 1 == 1 {
                flush()
                pending.append(contentsOf: b[q..<(p + 188)])
            } else if !pending.isEmpty {
                pending.append(contentsOf: b[q..<(p + 188)])
            }
        }
        flush()
        return out
    }
}

// MARK: - Broadcastify sign in and stream resolution

/// A failure with a sentence in it, because every one of these ends up on
/// screen in front of somebody who has to decide what to do about it.
struct Fault: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}

final class Broadcastify {
    static let shared = Broadcastify()

    struct Stream {
        var playlist: URL
        var token: String
        var expires: Date?
    }

    let session: URLSession
    private let lock = NSLock()
    private var signedIn = false

    private init() {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        cfg.httpCookieAcceptPolicy = .always
        cfg.httpShouldSetCookies = true
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.timeoutIntervalForRequest = 25
        session = URLSession(configuration: cfg)
    }

    func forgetLogin() {
        lock.lock(); signedIn = false; lock.unlock()
    }

    /// Returns nil on success, or a sentence the operator can act on.
    func signIn(user: String, pass: String) -> String? {
        lock.lock()
        let already = signedIn
        lock.unlock()
        if already { return nil }

        if user.isEmpty || pass.isEmpty {
            return "add your Broadcastify username and password in Settings"
        }
        guard let login = URL(string: "https://www.broadcastify.com/login/") else {
            return "the Broadcastify login URL is malformed"
        }

        _ = HTTP.get(login, session: session)
        let r = HTTP.post(login, form: [
            "username": user,
            "password": pass,
            "action": "auth",
            "redirect": "https://www.broadcastify.com/account/",
        ], session: session, referer: "https://www.broadcastify.com/login/")

        if let e = r.error { return "could not reach Broadcastify: \(e.localizedDescription)" }
        let body = String(data: r.data ?? Data(), encoding: .utf8) ?? ""
        let ok = body.range(of: "Logout", options: .caseInsensitive) != nil
            || body.range(of: "My Account", options: .caseInsensitive) != nil
        if !ok {
            return "Broadcastify did not accept that username and password"
        }
        lock.lock(); signedIn = true; lock.unlock()
        return nil
    }

    /// Scrapes the feed page for the HLS playlist and the session token.
    func resolve(feedID: String) -> Result<Stream, Fault> {
        guard let page = URL(string: "https://www.broadcastify.com/listen/feed/\(feedID)") else {
            return .failure(Fault("feed id \(feedID) is not usable"))
        }
        let r = HTTP.get(page, session: session, referer: "https://www.broadcastify.com/")
        guard r.status == 200, let d = r.data,
              let html = String(data: d, encoding: .utf8) else {
            return .failure(Fault("the feed page would not load (HTTP \(r.status))"))
        }
        guard let raw = Self.jsString(html, key: "hlsUrl"), !raw.isEmpty,
              let playlist = URL(string: raw) else {
            forgetLogin()
            return .failure(Fault("no stream on the feed page, the sign in may have expired"))
        }
        let token = Self.jsString(html, key: "sessionId") ?? ""
        var expires: Date?
        let parts = token.split(separator: ".")
        if parts.count >= 2, let epoch = Double(parts[1]) {
            expires = Date(timeIntervalSince1970: epoch)
        }
        return .success(Stream(playlist: playlist, token: token, expires: expires))
    }

    /// Pulls one `key: "value"` out of the page's inline player config.
    static func jsString(_ html: String, key: String) -> String? {
        let pattern = key + "\\s*:\\s*\"(\\\\.|[^\"\\\\])*\""
        guard let m = html.range(of: pattern, options: .regularExpression) else { return nil }
        let chunk = String(html[m])
        guard let open = chunk.range(of: "\"") else { return nil }
        var s = String(chunk[open.upperBound...])
        if s.hasSuffix("\"") { s.removeLast() }
        return s.replacingOccurrences(of: "\\/", with: "/")
                .replacingOccurrences(of: "\\\"", with: "\"")
                .replacingOccurrences(of: "\\\\", with: "\\")
    }
}

// MARK: - live playlist follower

/* A live playlist is a sliding window roughly 24 seconds wide, so anything not
   collected promptly is gone. This polls, downloads whatever is new, and hands
   back raw transport stream bytes plus how many seconds of audio they hold. */
final class HLSPuller {
    private var seen = Set<String>()
    private var order: [String] = []
    private var primed = false
    private(set) var buffer = Data()
    private(set) var seconds: Double = 0

    struct Poll {
        var added = 0
        var error: String?
    }

    func takeBuffer() -> Data {
        let d = buffer
        buffer = Data()
        seconds = 0
        return d
    }

    func poll(_ stream: Broadcastify.Stream, session: URLSession) -> Poll {
        var comps = URLComponents(url: stream.playlist, resolvingAgainstBaseURL: false)
        if !stream.token.isEmpty {
            comps?.queryItems = [URLQueryItem(name: "s", value: stream.token)]
        }
        guard let url = comps?.url else { return Poll(added: 0, error: "playlist URL is malformed") }

        let r = HTTP.get(url, session: session,
                         referer: "https://www.broadcastify.com/", timeout: 15)
        guard r.status == 200, let d = r.data,
              let text = String(data: d, encoding: .utf8) else {
            if let e = r.error { return Poll(added: 0, error: e.localizedDescription) }
            return Poll(added: 0, error: "playlist returned HTTP \(r.status)")
        }

        var entries: [(uri: String, dur: Double)] = []
        var dur: Double = 4
        for line in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
            let s = line.trimmingCharacters(in: .whitespaces)
            if s.hasPrefix("#EXTINF:") {
                dur = Double(s.dropFirst(8).prefix { $0 != "," }) ?? 4
            } else if !s.isEmpty && !s.hasPrefix("#") {
                entries.append((s, dur))
            }
        }
        if entries.isEmpty { return Poll(added: 0, error: "the playlist has no segments") }

        if !primed {                       // join near live, the rest already rolled off
            primed = true
            for e in entries.dropLast(2) { remember(e.uri) }
        }

        var added = 0
        for e in entries where !seen.contains(e.uri) {
            remember(e.uri)
            guard let seg = URL(string: e.uri, relativeTo: stream.playlist)?.absoluteURL else { continue }
            let sr = HTTP.get(seg, session: session,
                              referer: "https://www.broadcastify.com/", timeout: 20)
            if sr.status == 200, let sd = sr.data, !sd.isEmpty {
                buffer.append(sd)
                seconds += e.dur
                added += 1
            }
        }
        return Poll(added: added, error: nil)
    }

    private func remember(_ uri: String) {
        guard seen.insert(uri).inserted else { return }
        order.append(uri)
        if order.count > 300 {
            for old in order.prefix(150) { seen.remove(old) }
            order.removeFirst(150)
        }
    }
}
