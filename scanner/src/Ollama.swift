import Foundation

/* The local extraction engine: Ollama on this Mac, doing the reading the
   cloud model used to be paid for. The API account ran its whole credit
   balance dry in ten days, and the biggest line on that bill was a small
   fixed reading task performed thousands of times. This Mac is already
   running Whisper on live radio; the extraction is a smaller job than the
   transcription that feeds it, and a local token costs nothing.

   What this file deliberately does NOT own: the prompt, the schema, and the
   judgment. Those are fetched from the dashboard (/api/extract-contract) so
   they live in exactly one place, and every guardrail runs server side on
   whatever this model returns. A wrong answer here costs one transmission a
   cloud-budget slot, never a wrong pin. */

struct LocalModel: Identifiable, Hashable {
    let id: String        // the ollama tag
    let label: String
    let gigabytes: Double
    let note: String

    static let all: [LocalModel] = [
        LocalModel(id: "qwen2.5:3b-instruct", label: "Qwen 2.5, 3B", gigabytes: 1.9,
                   note: "The light one. Fits an 8GB Mac beside Whisper, and misses more."),
        LocalModel(id: "qwen2.5:7b-instruct", label: "Qwen 2.5, 7B", gigabytes: 4.7,
                   note: "The balance. Wants 16GB alongside a big Whisper model."),
        LocalModel(id: "llama3.1:8b", label: "Llama 3.1, 8B", gigabytes: 4.9,
                   note: "The alternative at the same weight, if Qwen reads Boston badly."),
    ]
    static let recommendedID = "qwen2.5:7b-instruct"
}

/* The contract, verbatim from the server. Kept as raw JSON blobs because the
   only consumer is the request body, and re-typing a schema in Swift would be
   a second copy of something whose whole point is having one copy. */
struct ExtractContract {
    let version: String
    let system: String
    let format: Any
    let options: Any

    static let cacheKey = "extract-contract-v1"

    static func decode(_ data: Data) -> ExtractContract? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let v = o["version"] as? String,
              let s = o["system"] as? String,
              let f = o["format"], let op = o["options"] else { return nil }
        return ExtractContract(version: v, system: s, format: f, options: op)
    }

    static func cached() -> ExtractContract? {
        guard let d = UserDefaults.standard.data(forKey: cacheKey) else { return nil }
        return decode(d)
    }
}

final class Ollama: ObservableObject {
    static let host = URL(string: "http://127.0.0.1:11434")!

    @Published var reachable: Bool?          // nil until first asked
    @Published var installed: Set<String> = []
    @Published var progress: [String: Double] = [:]
    @Published var failure: [String: String] = [:]
    @Published var contractVersion: String?

    private var pulls: [String: URLSessionDataTask] = [:]

    /* ------------------------------------------------------------ status --- */

    func refresh() {
        var req = URLRequest(url: Self.host.appendingPathComponent("api/tags"))
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, _, err in
            DispatchQueue.main.async {
                guard let self else { return }
                guard err == nil, let data,
                      let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      let models = o["models"] as? [[String: Any]] else {
                    self.reachable = false; return
                }
                self.reachable = true
                self.installed = Set(models.compactMap { $0["name"] as? String }
                    .map { $0.hasSuffix(":latest") ? String($0.dropLast(7)) : $0 })
            }
        }.resume()
    }

    /* -------------------------------------------------------------- pull --- */

    /* Ollama streams pull progress as NDJSON. Chunk boundaries do not respect
       line boundaries, so lines are reassembled here before parsing. */
    func pull(_ m: LocalModel, note: @escaping (String) -> Void) {
        failure[m.id] = nil
        progress[m.id] = 0
        note("pulling \(m.label) (\(m.gigabytes) GB), this is a one time download")
        var req = URLRequest(url: Self.host.appendingPathComponent("api/pull"))
        req.httpMethod = "POST"
        req.timeoutInterval = 3600
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["model": m.id, "stream": true])

        let buf = LineBuffer()
        let delegate = StreamDelegate(onChunk: { [weak self] data in
            for line in buf.feed(data) {
                guard let o = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
                if let e = o["error"] as? String {
                    DispatchQueue.main.async { self?.failure[m.id] = e; self?.progress[m.id] = nil }
                    return
                }
                if let done = o["completed"] as? Double, let total = o["total"] as? Double, total > 0 {
                    DispatchQueue.main.async { self?.progress[m.id] = done / total }
                }
                if (o["status"] as? String) == "success" {
                    DispatchQueue.main.async {
                        self?.progress[m.id] = nil
                        self?.installed.insert(m.id)
                        note("\(m.label) is ready")
                    }
                }
            }
        }, onEnd: { [weak self] err in
            DispatchQueue.main.async {
                if let err { self?.failure[m.id] = err; }
                self?.progress[m.id] = nil
                self?.refresh()
            }
        })
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: req)
        pulls[m.id] = task
        task.resume()
    }

    func cancel(_ m: LocalModel) {
        pulls[m.id]?.cancel(); pulls[m.id] = nil
        progress[m.id] = nil
    }

    /* ---------------------------------------------------------- contract --- */

    static func fetchContract(endpoint: String, token: String,
                              done: @escaping (ExtractContract?) -> Void) {
        guard var url = URL(string: endpoint), !token.isEmpty else { done(ExtractContract.cached()); return }
        url.appendPathComponent("api"); url.appendPathComponent("extract-contract")
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (200 ..< 300).contains(code), let data, let c = ExtractContract.decode(data) {
                UserDefaults.standard.set(data, forKey: ExtractContract.cacheKey)
                done(c)
            } else {
                done(ExtractContract.cached())   // yesterday's contract beats none
            }
        }.resume()
    }

    /* ----------------------------------------------------------- extract --- */

    /* One transmission in, one raw JSON string out, mirroring the request
       lib/extract-local.js makes so the two paths cannot disagree. The answer
       ships unparsed beyond validity: judgment belongs to the server. */
    static func extract(text: String, prior: [String], contract: ExtractContract,
                        model: String, timeout: TimeInterval,
                        done: @escaping (String?) -> Void) {
        var user = ""
        if !prior.isEmpty {
            user += "Earlier on this channel (background only, oldest first):\n"
                 + prior.suffix(3).map { "- " + String($0.prefix(220)) }.joined(separator: "\n") + "\n\n"
        }
        user += "Current transmission transcript:\n\n" + String(text.prefix(4000))
        let body: [String: Any] = [
            "model": model, "stream": false,
            "format": contract.format, "options": contract.options,
            "messages": [["role": "system", "content": contract.system],
                         ["role": "user", "content": user]],
        ]
        var req = URLRequest(url: host.appendingPathComponent("api/chat"))
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { data, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard err == nil, (200 ..< 300).contains(code), let data,
                  let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let msg = o["message"] as? [String: Any],
                  let raw = msg["content"] as? String, !raw.isEmpty,
                  let parsed = try? JSONSerialization.jsonObject(with: Data(raw.utf8)),
                  parsed is [String: Any] else { done(nil); return }
            done(raw)
        }.resume()
    }
}

/* ---- plumbing ---- */

private final class LineBuffer {
    private var rest = ""
    func feed(_ d: Data) -> [String] {
        rest += String(data: d, encoding: .utf8) ?? ""
        var lines = rest.components(separatedBy: "\n")
        rest = lines.removeLast()
        return lines.filter { !$0.isEmpty }
    }
}

private final class StreamDelegate: NSObject, URLSessionDataDelegate {
    let onChunk: (Data) -> Void
    let onEnd: (String?) -> Void
    init(onChunk: @escaping (Data) -> Void, onEnd: @escaping (String?) -> Void) {
        self.onChunk = onChunk; self.onEnd = onEnd
    }
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) { onChunk(data) }
    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onEnd(error.map { ($0 as NSError).code == NSURLErrorCancelled ? "cancelled" : $0.localizedDescription })
        s.finishTasksAndInvalidate()
    }
}
