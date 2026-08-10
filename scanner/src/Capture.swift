import Foundation

enum CaptureEvent {
    case state(String, String)              // sourceID, state
    case audio(String, Double)              // sourceID, peak 0...1
    case segment(String)
    case gated(String)
    case text(String, String, Data?)        // sourceID, transcript, m4a clip
    case failed(String, String)             // sourceID, human readable reason
    case log(String)
    case timing(String, Double, Double)     // sourceID, audio seconds, wall seconds
}

/* One stream in, one transcript out, entirely inside this process.

   Broadcastify feeds go: sign in -> scrape the feed page for the HLS playlist
   and session token -> follow the playlist -> demux MPEG transport stream to
   MP3 -> afconvert -> loudness gate -> whisper.

   Anything else that is a plain audio URL goes straight to the MP3 framer.
   afconvert ships with macOS and whisper ships inside the app bundle, so there
   is nothing to install and nothing to keep in sync. */
final class Capture {

    struct Options {
        var sources: [Source] = []
        var bfUser = ""
        var bfPass = ""
        var segmentSeconds: Double = 15
        var silenceGate: Double = 0.01
        var modelID = SpeechModel.bundledID
    }

    private let lock = NSLock()
    private var opts = Options()
    private var stopping = true
    private var raws: [String: RawStream] = [:]
    private var taps: [String: SystemAudioTap] = [:]
    let work = OperationQueue()

    var onEvent: ((CaptureEvent) -> Void)?

    init() {
        work.maxConcurrentOperationCount = 1        // whisper gets the floor to itself
        work.name = "relay.transcribe"
        work.qualityOfService = .utility
    }

    /* ------------------------------------------------------------ tooling --- */

    static var whisperBinary: URL? {
        if let r = Bundle.main.resourceURL {
            let bundled = r.appendingPathComponent("bin/whisper-cli")
            if FileManager.default.isExecutableFile(atPath: bundled.path) { return bundled }
        }
        for p in ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
        where FileManager.default.isExecutableFile(atPath: p) {
            return URL(fileURLWithPath: p)
        }
        return nil
    }

    /* The selection wins, then whatever shipped inside the app. A model that
       was chosen and then deleted must not take the feeds down with it. */
    static func modelFile(_ id: String) -> URL? { ModelStore.resolve(id) }

    static var toolingProblem: String? {
        if whisperBinary == nil { return "the speech engine is missing from the app bundle" }
        if ModelStore.resolve(SpeechModel.bundledID) == nil {
            return "the speech model is missing from the app bundle"
        }
        return nil
    }

    /* -------------------------------------------------------- start / stop --- */

    private var isStopping: Bool {
        lock.lock(); defer { lock.unlock() }
        return stopping
    }

    func start(_ options: Options) {
        lock.lock()
        opts = options
        stopping = false
        lock.unlock()

        /* Hold the Mac awake for as long as this runs. The screen too, but only
           when something is being tapped, since an application tap dies with
           the display and there is no reason to burn a monitor otherwise. */
        let tapping = options.sources.contains { $0.enabled && $0.isConfigured && $0.isAppAudio }
        Wakefulness.hold(screenToo: tapping)
        emit(.log(Wakefulness.describe))

        for s in options.sources where s.enabled && s.isConfigured {
            /* An application tap is event driven, so it needs no thread of its
               own. It is armed once and then feeds the same work queue every
               other source does. */
            if s.isAppAudio { arm(s); continue }
            let t = Thread { [weak self] in self?.loop(s) }
            t.name = "relay.\(s.slug)"
            t.qualityOfService = .utility
            t.start()
        }
    }

    /* ------------------------------------------------------ application tap --- */

    private func arm(_ s: Source) {
        let tap = SystemAudioTap()
        tap.segmentSeconds = options.segmentSeconds
        tap.onState = { [weak self] state in self?.emit(.state(s.id, state)) }
        tap.onFailure = { [weak self] why in
            self?.emit(.failed(s.id, why))
            self?.emit(.state(s.id, "error"))
        }
        /* Something temporary that the tap is already working its way out of.
           It belongs in the log so the operator can see the machine trying,
           and it must not be dressed up as a failure, because a feed that says
           error while it is busy reconnecting teaches people to ignore the
           word error. */
        tap.onNotice = { [weak self] why in
            self?.emit(.log("[\(s.slug)] \(why)"))
        }
        tap.onSegment = { [weak self] wav in
            guard let self, !self.isStopping else { return }
            self.emit(.segment(s.id))
            self.work.addOperation { [weak self] in self?.runWhisper(wav, source: s) }
        }
        lock.lock(); taps[s.id] = tap; lock.unlock()
        emit(.state(s.id, "connecting"))
        emit(.log("[\(s.slug)] tapping audio from \(s.bundleID)"))
        tap.start(bundleID: s.bundleID)
    }

    func stop() {
        lock.lock()
        stopping = true
        let open = raws
        let live = taps
        raws.removeAll()
        taps.removeAll()
        lock.unlock()
        for (_, r) in open { r.stop() }
        for (_, t) in live { t.stop() }
        work.cancelAllOperations()
        Wakefulness.release()
        Broadcastify.shared.forgetLogin()
    }

    private func emit(_ e: CaptureEvent) {
        DispatchQueue.main.async { [weak self] in self?.onEvent?(e) }
    }

    private func nap(_ seconds: Double) {
        var left = seconds
        while left > 0 && !isStopping {
            Thread.sleep(forTimeInterval: min(0.25, left))
            left -= 0.25
        }
    }
}

// MARK: - per source worker

private extension Capture {

    var options: Options {
        lock.lock(); defer { lock.unlock() }
        return opts
    }

    /* People paste all three shapes of Broadcastify link, so pull the number
       out of whichever one showed up. */
    static func feedID(_ url: String) -> String? {
        if let r = url.range(of: "listen/feed/[0-9]+",
                             options: [.regularExpression, .caseInsensitive]) {
            let d = url[r].drop { !$0.isNumber }
            return d.isEmpty ? nil : String(d)
        }
        if let r = url.range(of: "audio\\.broadcastify\\.com/[0-9]+",
                             options: [.regularExpression, .caseInsensitive]) {
            let d = url[r].split(separator: "/").last.map(String.init) ?? ""
            return d.isEmpty ? nil : d
        }
        let t = url.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty, t.allSatisfy({ $0.isNumber }) { return t }
        return nil
    }

    static func isPlaylist(_ url: String) -> Bool {
        url.range(of: "\\.m3u8", options: [.regularExpression, .caseInsensitive]) != nil
    }
}

private extension Capture {

    /* One thread per feed. It reconnects on its own and backs off when the far
       end is unhappy, so a feed that goes down at 2am is live again by itself. */
    func loop(_ s: Source) {
        let o = options
        var backoff = 3.0
        emit(.state(s.id, "connecting"))

        while !isStopping {
            let began = Date()

            if s.isRapidSOS {
                rapidsos(s, seconds: o.segmentSeconds)

            } else if Capture.isPlaylist(s.url), let u = URL(string: s.url) {
                follow(Broadcastify.Stream(playlist: u, token: "", expires: nil),
                       source: s, seconds: o.segmentSeconds)

            } else if s.isBroadcastify {
                guard let fid = Capture.feedID(s.url) else {
                    emit(.failed(s.id, "that Broadcastify link has no feed number in it"))
                    emit(.state(s.id, "error"))
                    return
                }
                if let problem = Broadcastify.shared.signIn(user: o.bfUser, pass: o.bfPass) {
                    emit(.failed(s.id, problem))
                    emit(.state(s.id, "error"))
                    nap(backoff); backoff = min(backoff * 2, 90)
                    continue
                }
                switch Broadcastify.shared.resolve(feedID: fid) {
                case .success(let st):
                    follow(st, source: s, seconds: o.segmentSeconds)
                case .failure(let why):
                    emit(.failed(s.id, why.description))
                    emit(.state(s.id, "error"))
                    nap(backoff); backoff = min(backoff * 2, 90)
                    continue
                }

            } else {
                direct(s, seconds: o.segmentSeconds)
            }

            if isStopping { break }
            if Date().timeIntervalSince(began) > 60 { backoff = 3 }
            emit(.state(s.id, "connecting"))
            nap(backoff)
            backoff = min(backoff * 2, 90)
        }
        emit(.state(s.id, "idle"))
    }
}

private extension Capture {

    /* The live playlist path. The window is about twenty four seconds wide, so
       this polls every two seconds and takes only what it has not seen. */
    func follow(_ stream: Broadcastify.Stream, source s: Source, seconds: Double) {
        var st = stream
        let puller = HLSPuller()
        var misses = 0
        var nextRenew = Date.distantPast
        /* Set from inside the pool closure to leave the loop, since a closure
           cannot return the enclosing function. */
        var stopFollow = false
        emit(.state(s.id, "live"))

        while !isStopping {
            /* One pool per poll. This is a raw Thread that loops for the life
               of the app, and a raw Thread never drains its autorelease pool
               on its own. Every HTTP request here creates a DispatchSemaphore
               (a Mach port), a URLRequest, a dataTask and a response, and
               without this pool all of it accumulates for days until the
               process runs out of Mach ports and macOS kills it. Same crash,
               network side, as the subprocess side in Capture.run. */
            autoreleasepool {
                if s.isBroadcastify, let exp = st.expires,
                   exp.timeIntervalSinceNow < 120, Date() >= nextRenew,
                   let fid = Capture.feedID(s.url) {
                    nextRenew = Date().addingTimeInterval(30)
                    if case .success(let fresh) = Broadcastify.shared.resolve(feedID: fid) {
                        st = fresh
                        emit(.log("[\(s.slug)] listening token renewed"))
                    }
                }

                let p = puller.poll(st, session: Broadcastify.shared.session)
                if let e = p.error {
                    misses += 1
                    if misses >= 4 {
                        emit(.failed(s.id, e))
                        emit(.state(s.id, "error"))
                        isStopping ? () : (stopFollow = true)
                    }
                } else if p.added > 0 {
                    misses = 0
                }

                if !stopFollow, puller.seconds >= seconds {
                    let chunk = puller.takeBuffer()
                    emit(.segment(s.id))
                    work.addOperation { [weak self] in self?.transcribe(chunk, source: s) }
                }
            }
            if stopFollow { return }
            nap(2)
        }
    }
}

private extension Capture {

    /* Anything that is a plain endless audio URL, an Icecast relay or a local
       bridge. Frames are cut on sync words so every segment decodes cleanly. */
    func direct(_ s: Source, seconds: Double) {
        guard let u = URL(string: s.url) else {
            emit(.failed(s.id, "that address is not a usable URL"))
            emit(.state(s.id, "error"))
            return
        }
        let framer = MP3Framer()
        let raw = RawStream(url: u)
        lock.lock(); raws[s.id] = raw; lock.unlock()
        raw.start()
        emit(.state(s.id, "live"))

        while !isStopping {
            /* Same reason as follow(): a raw Thread that loops forever drains
               no pool of its own, so the Data buffers this moves accumulate
               without one. */
            var brk = false
            autoreleasepool {
                if let e = raw.failure {
                    emit(.failed(s.id, e))
                    emit(.state(s.id, "error"))
                    brk = true; return
                }
                let d = raw.take()
                if !d.isEmpty { framer.append(d) }
                while let seg = framer.drain(seconds: seconds) {
                    emit(.segment(s.id))
                    work.addOperation { [weak self] in
                        self?.decode(seg.data, ext: "mp3", source: s)
                    }
                }
                if raw.finished && d.isEmpty { brk = true }
            }
            if brk { break }
            nap(0.5)
        }
        raw.stop()
        lock.lock(); raws[s.id] = nil; lock.unlock()
    }

    /* Boston Police. The socket hands over whole transmissions rather than an
       endless bitstream, which is the one respect in which this feed is nicer
       than every other one here: the radio itself says where a clip begins and
       ends, so a segment is a complete thing somebody said instead of a slice
       of the clock that starts mid-word.

       Audio arrives already sixteen kilohertz mono, which is what Whisper
       wants, so this path skips afconvert entirely and hands PCM straight
       down. Nothing is written to disk on the way. */
    func rapidsos(_ s: Source, seconds: Double) {
        let stream = RapidSOSStream(channel: s.url, label: s.label)
        stream.start()
        if let e = stream.failure {
            emit(.failed(s.id, e))
            emit(.state(s.id, "error"))
            return
        }
        emit(.state(s.id, "live"))

        /* A whole transmission, but not an unbounded one: somebody who keys up
           and walks away should still be transcribed in pieces rather than
           held until they let go. */
        let cap = max(Int(seconds * 16_000), 16_000)
        let floorSamples = 16_000                    // a second, below which it is a click
        var buf: [Int16] = []

        while !isStopping {
            var brk = false
            autoreleasepool {
                if let e = stream.failure {
                    emit(.failed(s.id, e))
                    emit(.state(s.id, "error"))
                    brk = true; return
                }
                buf.append(contentsOf: stream.take())
                let ended = stream.transmissionEnded
                if (ended && buf.count >= floorSamples) || buf.count >= cap {
                    let chunk = buf
                    buf.removeAll(keepingCapacity: true)
                    emit(.segment(s.id))
                    work.addOperation { [weak self] in
                        self?.runWhisper(SystemAudioTap.wav(chunk), source: s)
                    }
                }
                /* finished without a failure is the cookie ageing out. The
                   supervisor above reconnects with a fresh one, which is the
                   whole reason this feed no longer dies twice a day. */
                if stream.finished { brk = true }
            }
            if brk { break }
            nap(0.4)
        }

        if buf.count >= floorSamples {
            let chunk = buf
            work.addOperation { [weak self] in
                self?.runWhisper(SystemAudioTap.wav(chunk), source: s)
            }
        }
        stream.stop()
    }
}

// MARK: - transport stream to text

private extension Capture {

    /* HLS hands back MPEG transport stream packets. Pull the audio elementary
       stream out of them before anything else can read it. */
    func transcribe(_ ts: Data, source s: Source) {
        guard !isStopping, ts.count > 1000 else { return }
        guard let found = TS.audioStream(ts) else {
            emit(.failed(s.id, "that segment carried no audio track"))
            return
        }
        let audio = TS.elementary(ts, pid: found.pid)
        guard audio.count > 2000 else { return }
        decode(audio, ext: found.ext, source: s)
    }

    func decode(_ audio: Data, ext: String, source s: Source) {
        guard !isStopping else { return }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("scanner-relay", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = UUID().uuidString.prefix(8)
        let src = dir.appendingPathComponent("\(s.slug)-\(stamp).\(ext)")
        let wav = dir.appendingPathComponent("\(s.slug)-\(stamp).wav")
        defer {
            try? FileManager.default.removeItem(at: src)
            try? FileManager.default.removeItem(at: wav)
        }

        do { try audio.write(to: src) } catch {
            emit(.failed(s.id, "could not stage audio: \(error.localizedDescription)"))
            return
        }

        /* afconvert ships with macOS, so the sixteen kilohertz mono step needs
           nothing installed. */
        let conv = Capture.run("/usr/bin/afconvert",
                               ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
                                src.path, wav.path])
        guard conv.code == 0,
              let pcm = try? Data(contentsOf: wav), pcm.count > 32_000 else {
            emit(.failed(s.id, "that segment would not decode"))
            return
        }
        runWhisper(pcm, source: s)
    }

    /* Everything downstream of "we have sixteen kilohertz mono" lives here, so
       the Broadcastify path and the application tap share one route to text.
       The tap already produces this shape, so it skips the conversion above and
       calls straight in.

       The clock wrapped around the decode is what the load readout is built
       from. Whisper runs one clip at a time, so the share of the wall clock
       spent inside this call is the real measure of how full the Mac is. */
    func runWhisper(_ pcm: Data, source s: Source) {
        guard !isStopping, pcm.count > 32_000 else { return }
        guard let whisper = Capture.whisperBinary,
              let model = Capture.modelFile(options.modelID) else {
            emit(.failed(s.id, Capture.toolingProblem ?? "the speech engine is missing"))
            return
        }

        let peak = Capture.rms(pcm)
        emit(.audio(s.id, peak))
        if peak < options.silenceGate {
            emit(.gated(s.id))
            return
        }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("scanner-relay", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let wav = dir.appendingPathComponent("\(s.slug)-\(UUID().uuidString.prefix(8))-w.wav")
        defer { try? FileManager.default.removeItem(at: wav) }
        do { try pcm.write(to: wav) } catch {
            emit(.failed(s.id, "could not stage audio: \(error.localizedDescription)"))
            return
        }

        let cores = ProcessInfo.processInfo.activeProcessorCount
        let threads = max(2, min(8, cores - 2))
        let audioSeconds = Double(pcm.count - 44) / 32_000.0
        let began = Date()
        let r = Capture.run(whisper.path,
                            ["-m", model.path, "-f", wav.path, "-l", "en",
                             "-t", "\(threads)", "-nt", "-np"])
        let wall = Date().timeIntervalSince(began)
        /* Reported even when the run fails, because a failed run still spent
           the machine's time and the readout should say so. */
        emit(.timing(s.id, audioSeconds, wall))

        guard r.code == 0 else {
            emit(.failed(s.id, "the speech engine exited \(r.code)"))
            return
        }

        let text = Capture.clean(r.out)
        if text.isEmpty { emit(.gated(s.id)); return }
        /* The clip rides the same event as its words. The WAV is still on
           disk here, one line above its deferred delete, and this is the
           last moment anything holds both the audio and the knowledge that
           it said something worth keeping. Encoding failure hands up nil,
           and nil costs the newsroom a play button, not a transmission. */
        emit(.text(s.id, text, Capture.encodeClip(wav)))
    }
}

// MARK: - small helpers

extension Capture {

    /* WAV to AAC in an m4a container, via afconvert, which ships on every Mac
       that has ever existed and needs no bundling. 48kbps on 16kHz mono radio
       is transparent; a fifteen second transmission comes out near 90KB,
       which is a tenth of the server's cap. The floor guard rejects the
       header-only file a failed convert leaves behind, and the ceiling guard
       means a runaway segment gets no clip rather than a refused upload. */
    static func encodeClip(_ wav: URL) -> Data? {
        let out = wav.deletingPathExtension().appendingPathExtension("m4a")
        defer { try? FileManager.default.removeItem(at: out) }
        let r = run("/usr/bin/afconvert",
                    ["-f", "m4af", "-d", "aac", "-b", "48000", wav.path, out.path])
        guard r.code == 0, let d = try? Data(contentsOf: out),
              d.count > 800, d.count <= 1_000_000 else { return nil }
        return d
    }

    /* stderr goes to the void on purpose. Whisper narrates its whole startup
       there, and a pipe nobody drains is a pipe that eventually deadlocks. */
    static func run(_ path: String, _ args: [String]) -> (code: Int32, out: String) {
        guard FileManager.default.isExecutableFile(atPath: path) else { return (-1, "") }
        /* The autorelease pool is not decoration. This runs thousands of times
           a day on background threads (whisper on every segment, afconvert on
           every kept clip), and a background thread does not drain its pool on
           its own. Process and Pipe are Foundation objects backed by Mach ports
           and file descriptors; without a pool draining each call, those ports
           accumulate for the life of the thread until the task hits the
           per-process Mach port limit and macOS kills the app. That is the
           EXC_RESOURCE / PORT_SPACE crash the relay was dying of every several
           hours. The explicit close() is belt to the pool's braces: it returns
           the pipe's descriptors the instant the read is done rather than at
           pool drain. */
        return autoreleasepool {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: path)
            p.arguments = args
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardInput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            let readHandle = pipe.fileHandleForReading
            do { try p.run() } catch { try? readHandle.close(); return (-1, "") }
            let data = readHandle.readDataToEndOfFile()
            p.waitUntilExit()
            try? readHandle.close()
            return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        }
    }

    /// Loudness of a sixteen bit mono WAV, sampled rather than summed whole.
    static func rms(_ wav: Data) -> Double {
        guard wav.count > 4096 else { return 0 }
        var sum = 0.0
        var n = 0
        wav.withUnsafeBytes { raw in
            let total = (raw.count - 44) / 2
            guard total > 0 else { return }
            let step = max(1, total / 8000)
            var i = 0
            while i < total {
                let v = raw.loadUnaligned(fromByteOffset: 44 + i * 2, as: Int16.self)
                let f = Double(v) / 32768.0
                sum += f * f
                n += 1
                i += step
            }
        }
        return n > 0 ? (sum / Double(n)).squareRoot() : 0
    }
}

extension Capture {

    /* Whisper does not return nothing when it hears nothing. It returns a
       plausible sentence. Dead air on a scanner comes back as bracketed stage
       directions or one word typed over and over, so both get dropped here
       before anything reaches the newsroom. */
    static func clean(_ raw: String) -> String {
        var t = raw.replacingOccurrences(of: "\r", with: " ")
                   .replacingOccurrences(of: "\n", with: " ")
        for pattern in ["\\[[^\\]]*\\]", "\\([^\\)]*\\)", "\\*[^\\*]*\\*"] {
            t = t.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
        }
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
             .trimmingCharacters(in: .whitespacesAndNewlines)
        if t.count < 4 { return "" }

        let strip = CharacterSet(charactersIn: ".,!?;:-\"'")
        let words = t.split(separator: " ").map {
            $0.lowercased().trimmingCharacters(in: strip)
        }.filter { !$0.isEmpty }
        if words.isEmpty { return "" }

        let unique = Set(words)
        if words.count >= 3 && unique.count <= 2 { return "" }   // " you you you you"

        let junk: Set<String> = ["you", "thank you", "thanks for watching",
                                 "thank you for watching", "bye", "silence",
                                 "blank audio", "music", "subtitles by the amara org community"]
        if junk.contains(words.joined(separator: " ")) { return "" }
        return t
    }
}

// MARK: - plain endless stream

/* A thin reader for anything that is not HLS. It hands raw bytes to the frame
   parser and reports why it stopped in a sentence a person can act on. */
final class RawStream: NSObject, URLSessionDataDelegate {
    private let url: URL
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private let lock = NSLock()
    private var buf = Data()
    private var done = false
    private var problem: String?

    init(url: URL) {
        self.url = url
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = .greatestFiniteMagnitude
        cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .utility
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: q)
    }

    var failure: String? { lock.lock(); defer { lock.unlock() }; return problem }
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return done }

    func take() -> Data {
        lock.lock(); defer { lock.unlock() }
        let d = buf
        buf = Data()
        return d
    }

    func start() {
        var req = URLRequest(url: url)
        req.setValue(HTTP.ua, forHTTPHeaderField: "User-Agent")
        req.setValue("*/*", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 30
        task = session.dataTask(with: req)
        task?.resume()
    }

    func stop() {
        task?.cancel()
        session.invalidateAndCancel()
        lock.lock(); done = true; lock.unlock()
    }
}

extension RawStream {

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            lock.lock()
            problem = http.statusCode == 401 || http.statusCode == 403
                ? "the stream refused the connection (HTTP \(http.statusCode))"
                : "the stream answered HTTP \(http.statusCode)"
            done = true
            lock.unlock()
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        buf.append(data)
        if buf.count > 1 << 23 { buf.removeFirst(buf.count - (1 << 22)) }
        lock.unlock()
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        if let e = error, problem == nil, (e as NSError).code != NSURLErrorCancelled {
            problem = "the stream dropped: \(e.localizedDescription)"
        }
        done = true
        lock.unlock()
    }
}
