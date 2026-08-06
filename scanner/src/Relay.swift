import Foundation

struct Dispatch: Codable, Equatable {
    var src: String
    var city: String
    /* The municipalities this feed's transmitter actually covers, comma
       separated. Every town in Massachusetts has a Main Street, so the server
       cannot place a street name without knowing which towns are in play. A
       feed that covers forty towns and never names one gets no pin, on
       purpose, because a pin in the wrong town is worse than an empty map. */
    var scope: String = ""
    /* The URL /api/clip answered with, when it did. Optional and last, so a
       queue persisted by an older build decodes cleanly into this shape. */
    var clip: String? = nil
    /* The local model's raw reading of this transmission, as the JSON string
       Ollama produced. A string rather than a parsed object because Codable
       wants a type and the server is the only party that should be parsing
       judgment anyway. nil in cloud mode, and whenever the model was slow,
       wrong-shaped, or off. */
    var ex: String? = nil
    var text: String
    var at: String
    var seq: Int
}

/* Everything transcribed goes on a queue and stays there until the server has
   actually taken it. A flaky hotel wifi should cost latency, never transmissions.
   The wire format is the one the dashboard already speaks, so this app is a drop
   in replacement for the old node agent. */
final class Relay {

    var endpoint = ""
    var token = ""
    var machine = ""

    /// Called on the main queue with (state, queueDepth).
    var onState: ((String, Int) -> Void)?
    var onLog: ((String) -> Void)?

    /// Supplies the current per source health block at send time.
    var healthProvider: (() -> [[String: Any]])?

    private var queue: [Dispatch] = []
    private let lock = NSLock()
    private var seq = 0
    private var sending = false
    private var backoff: TimeInterval = 0
    private var nextSendAt = Date.distantPast
    private var timer: Timer?
    private var lastHeartbeat = Date.distantPast

    private static let batchMax = 40
    private static let queueMax = 600

    func start() {
        stop()
        let t = Timer(timeInterval: 4, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func enqueue(src: String, city: String, scope: String = "", text: String, clip: Data? = nil, ex: String? = nil) {
        let at = ISO8601DateFormatter().string(from: Date())
        /* The clip goes up before its words go on the queue, because the
           transmission record is born on the server with its clip URL or
           without one, and there is no attach-later. The words never wait
           long: eight seconds is the worst case, and only when the clip
           store is limping while the dashboard is fine. When the dashboard
           itself is unreachable the relay is already backing off, and paying
           the upload tax per clip on top of that would just delay the queue
           it is trying to drain, so deep backoff skips clips entirely. */
        if let clip, backoff < 60 {
            uploadClip(clip, src: src, at: at) { [weak self] url in
                self?.append(src: src, city: city, scope: scope, text: text, at: at, clip: url, ex: ex)
            }
        } else {
            append(src: src, city: city, scope: scope, text: text, at: at, clip: nil, ex: ex)
        }
    }

    private func append(src: String, city: String, scope: String, text: String, at: String, clip: String?, ex: String?) {
        lock.lock()
        queue.append(Dispatch(src: src, city: city, scope: scope, clip: clip, ex: ex, text: text,
                              at: at, seq: seq))
        seq += 1
        if queue.count > Self.queueMax { queue.removeFirst(queue.count - Self.queueMax) }
        let depth = queue.count
        lock.unlock()
        DispatchQueue.main.async { [weak self] in self?.onState?("queued", depth) }
    }

    /* One clip, one POST, one answer. Anything other than a 2xx with a URL in
       it resolves to nil, and nil means the transmission ships without audio.
       No retries: the audio is fifteen seconds old and its words are waiting
       on this callback, so a second attempt buys little and costs freshness. */
    private func uploadClip(_ data: Data, src: String, at: String, done: @escaping (String?) -> Void) {
        guard var url = URL(string: endpoint), !token.isEmpty else { done(nil); return }
        url.appendPathComponent("api")
        url.appendPathComponent("clip")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 8
        req.setValue("audio/mp4", forHTTPHeaderField: "content-type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue(machine, forHTTPHeaderField: "x-bcc-machine")
        req.setValue(src, forHTTPHeaderField: "x-bcc-src")
        req.setValue(at, forHTTPHeaderField: "x-bcc-at")
        req.httpBody = data
        URLSession.shared.dataTask(with: req) { body, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard err == nil, (200 ..< 300).contains(code), let body,
                  let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let u = obj["url"] as? String, !u.isEmpty else { done(nil); return }
            done(u)
        }.resume()
    }

    private func tick() {
        guard Date() >= nextSendAt, !sending else { return }
        lock.lock()
        let depth = queue.count
        lock.unlock()
        let needHeartbeat = Date().timeIntervalSince(lastHeartbeat) > 30
        if depth == 0 && !needHeartbeat { return }
        flush()
    }

    private func flush() {
        guard !endpoint.isEmpty, !token.isEmpty else { return }
        lock.lock()
        let items = Array(queue.prefix(Self.batchMax))
        lock.unlock()

        guard var url = URL(string: endpoint) else { return }
        url.appendPathComponent("api")
        url.appendPathComponent("ingest")

        var body: [String: Any] = [
            "machine": machine,
            "at": ISO8601DateFormatter().string(from: Date()),
            "items": items.map { item -> [String: Any] in
                var d: [String: Any] = ["src": item.src, "city": item.city, "scope": item.scope,
                                        "text": item.text, "at": item.at, "seq": item.seq]
                if let c = item.clip { d["clip"] = c }
                /* Parsed here at the wire, not upstream, so the queue stays
                   Codable and a malformed reading dies quietly at the door. */
                if let x = item.ex,
                   let o = try? JSONSerialization.jsonObject(with: Data(x.utf8)),
                   o is [String: Any] { d["ex"] = o }
                return d
            },
        ]
        body["health"] = healthProvider?() ?? []
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue(machine, forHTTPHeaderField: "x-bcc-machine")
        req.httpBody = data

        sending = true
        lastHeartbeat = Date()
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, err in
            guard let self else { return }
            self.sending = false
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0

            if err == nil, (200 ..< 300).contains(code) {
                self.lock.lock()
                if self.queue.count >= items.count { self.queue.removeFirst(items.count) }
                let depth = self.queue.count
                self.lock.unlock()
                if self.backoff > 0 {
                    self.backoff = 0
                    DispatchQueue.main.async { self.onLog?("dashboard reachable again") }
                }
                self.nextSendAt = .distantPast
                DispatchQueue.main.async { self.onState?(depth > 0 ? "queued" : "ok", depth) }
                return
            }

            self.lock.lock(); let depth = self.queue.count; self.lock.unlock()

            /* A rejected token will be rejected again in four seconds and in
               forty. Back all the way off and say so, because this is the one
               failure only a person can clear. */
            if code == 401 || code == 403 {
                self.backoff = min(300, max(60, self.backoff * 2))
                self.nextSendAt = Date().addingTimeInterval(self.backoff)
                DispatchQueue.main.async {
                    self.onLog?("the dashboard rejected this machine's token (HTTP \(code))")
                    self.onState?("token rejected", depth)
                }
                return
            }

            self.backoff = min(120, self.backoff > 0 ? self.backoff * 2 : 5)
            self.nextSendAt = Date().addingTimeInterval(self.backoff)
            let why = err?.localizedDescription ?? "HTTP \(code)"
            DispatchQueue.main.async {
                self.onLog?("could not reach the dashboard (\(why)); \(depth) held, retrying in \(Int(self.backoff))s")
                self.onState?("offline", depth)
            }
        }.resume()
    }

    /* A one shot check so a person can find out whether the endpoint and token
       are right without starting capture and waiting for radio traffic. */
    func test(_ done: @escaping (Bool, String) -> Void) {
        guard var url = URL(string: endpoint), !token.isEmpty else {
            done(false, "fill in the dashboard URL and the ingest token first")
            return
        }
        url.appendPathComponent("api")
        url.appendPathComponent("ingest")
        let body: [String: Any] = ["machine": machine,
                                   "at": ISO8601DateFormatter().string(from: Date()),
                                   "items": [], "health": []]
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue(machine, forHTTPHeaderField: "x-bcc-machine")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: req) { _, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                if let e = err { done(false, e.localizedDescription); return }
                switch code {
                case 200 ..< 300: done(true, "connected, the dashboard accepted this machine")
                case 401, 403:    done(false, "the dashboard rejected the ingest token")
                case 404:         done(false, "no ingest endpoint at that URL, check the address")
                default:          done(false, "the dashboard answered HTTP \(code)")
                }
            }
        }.resume()
    }
}
