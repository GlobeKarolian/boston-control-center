import Foundation

/* ---------------------------------------------------------------- catalog --- */

/* Whisper models trade speed for accuracy in a straight line, and the right
   pick depends on the machine and how many feeds it is carrying. Rather than
   guess, the app ships one model and lets the operator fetch any of the others
   on demand. */
struct SpeechModel: Identifiable, Hashable {
    let id: String
    let file: String
    let label: String
    let megabytes: Int
    let note: String

    var url: URL {
        URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/\(file)")!
    }

    /// The one built into the app, so there is always something to fall back to.
    static let bundledID = "small.en"

    static let all: [SpeechModel] = [
        .init(id: "tiny.en", file: "ggml-tiny.en.bin",
              label: "Tiny, English", megabytes: 75,
              note: "Fastest by a wide margin. Catches street names and unit numbers, loose on full sentences."),
        .init(id: "base.en", file: "ggml-base.en.bin",
              label: "Base, English", megabytes: 142,
              note: "Roughly three times faster than Small, with a real accuracy cost on clipped radio."),
        .init(id: "small.en", file: "ggml-small.en.bin",
              label: "Small, English", megabytes: 466,
              note: "Ships inside the app. The best balance for scanner traffic on Apple silicon."),
        .init(id: "medium.en", file: "ggml-medium.en.bin",
              label: "Medium, English", megabytes: 1500,
              note: "Clearly better on noisy or clipped audio. About three times the compute of Small."),
        .init(id: "large-v3-turbo", file: "ggml-large-v3-turbo.bin",
              label: "Large v3 Turbo", megabytes: 1620,
              note: "Best accuracy here, and faster than Medium on Apple silicon. Heaviest download."),
    ]

    static func find(_ id: String) -> SpeechModel {
        all.first { $0.id == id } ?? all.first { $0.id == bundledID }!
    }
}

/* ------------------------------------------------------------------ store --- */

/* Downloaded models sit next to the config rather than inside the app bundle.
   Replacing the app then costs nothing, and a two gigabyte download survives
   an upgrade. */
enum ModelStore {
    static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("ScannerRelay/models", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()

    static func bundled(_ m: SpeechModel) -> URL? {
        guard let r = Bundle.main.resourceURL else { return nil }
        let u = r.appendingPathComponent("models/\(m.file)")
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    /* Size is checked as well as existence. A download killed halfway leaves a
       short file behind, and handing that to whisper produces a confusing
       crash instead of an honest "not downloaded yet". */
    static func downloaded(_ m: SpeechModel) -> URL? {
        let u = dir.appendingPathComponent(m.file)
        guard let a = try? FileManager.default.attributesOfItem(atPath: u.path),
              let size = a[.size] as? Int,
              size > Int(Double(m.megabytes) * 900_000) else { return nil }
        return u
    }

    /// A model the source tree happens to carry. Useful on the build machine,
    /// invisible on every other Mac.
    static func vendored(_ m: SpeechModel) -> URL? {
        let u = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Developer/bcc/scanner/vendor/\(m.file)")
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    static func located(_ m: SpeechModel) -> URL? {
        downloaded(m) ?? bundled(m) ?? vendored(m)
    }

    static func isReady(_ m: SpeechModel) -> Bool { located(m) != nil }

    /* A selection that is somehow missing must not take the feeds down, so this
       always ends at the bundled model rather than at nil. */
    static func resolve(_ id: String) -> URL? {
        if let u = located(SpeechModel.find(id)) { return u }
        return located(SpeechModel.find(SpeechModel.bundledID))
    }

    static func remove(_ m: SpeechModel) {
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(m.file))
    }
}

/* --------------------------------------------------------------- download --- */

/* URLSession reports progress to a delegate on a background queue. Making the
   observable object itself the delegate would drag main actor work into that
   callback, so a small forwarder sits in between and hops the queue once. */
final class DownloadSpy: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    var onProgress: ((Double) -> Void)?
    var onFinish: ((URL?, String?) -> Void)?
    private let dest: URL

    init(dest: URL) { self.dest = dest }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64,
                    totalBytesWritten written: Int64,
                    totalBytesExpectedToWrite total: Int64) {
        guard total > 0 else { return }
        let f = Double(written) / Double(total)
        DispatchQueue.main.async { [onProgress] in onProgress?(f) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        /* A refusal from the far end still lands here, carrying an HTML error
           page. Without this check that page gets saved under the model's name
           and whisper is handed garbage. */
        if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
            let code = http.statusCode
            DispatchQueue.main.async { [onFinish] in
                onFinish?(nil, "the download server answered \(code)")
            }
            return
        }
        /* The temporary file is deleted the moment this returns, so the move
           has to happen here and not back on the main queue. */
        var moved: URL?
        var problem: String?
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: location, to: dest)
            moved = dest
        } catch { problem = error.localizedDescription }
        DispatchQueue.main.async { [onFinish] in onFinish?(moved, problem) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        guard let error else { return }
        if (error as NSError).code == NSURLErrorCancelled { return }
        let why = error.localizedDescription
        DispatchQueue.main.async { [onFinish] in onFinish?(nil, why) }
    }
}

@MainActor
final class ModelDownloads: ObservableObject {
    @Published var progress: [String: Double] = [:]
    @Published var failure: [String: String] = [:]
    @Published var ready: Set<String> = []

    private var tasks: [String: URLSessionDownloadTask] = [:]
    private var spies: [String: DownloadSpy] = [:]
    private var sessions: [String: URLSession] = [:]

    init() { rescan() }

    func rescan() {
        ready = Set(SpeechModel.all.filter { ModelStore.isReady($0) }.map(\.id))
    }

    func isWorking(_ m: SpeechModel) -> Bool { tasks[m.id] != nil }

    func start(_ m: SpeechModel, note: @escaping (String) -> Void) {
        guard tasks[m.id] == nil, !ModelStore.isReady(m) else { return }
        failure[m.id] = nil
        progress[m.id] = 0

        let spy = DownloadSpy(dest: ModelStore.dir.appendingPathComponent(m.file))
        spy.onProgress = { [weak self] f in self?.progress[m.id] = f }
        spy.onFinish = { [weak self] url, problem in
            guard let self else { return }
            self.clear(m.id)
            if let problem {
                self.failure[m.id] = problem
                note("\(m.label) download failed, \(problem)")
            } else if url != nil {
                self.rescan()
                note("\(m.label) is ready, \(m.megabytes) MB on disk")
            }
        }

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForResource = 7200
        let session = URLSession(configuration: cfg, delegate: spy, delegateQueue: nil)
        let task = session.downloadTask(with: m.url)
        sessions[m.id] = session
        spies[m.id] = spy
        tasks[m.id] = task
        note("downloading \(m.label), \(m.megabytes) MB")
        task.resume()
    }

    func cancel(_ m: SpeechModel) {
        tasks[m.id]?.cancel()
        sessions[m.id]?.invalidateAndCancel()
        clear(m.id)
    }

    func delete(_ m: SpeechModel, note: @escaping (String) -> Void) {
        guard ModelStore.downloaded(m) != nil else { return }
        ModelStore.remove(m)
        rescan()
        note("removed the downloaded copy of \(m.label)")
    }

    private func clear(_ id: String) {
        tasks[id] = nil
        spies[id] = nil
        sessions[id]?.finishTasksAndInvalidate()
        sessions[id] = nil
        progress[id] = nil
    }
}
