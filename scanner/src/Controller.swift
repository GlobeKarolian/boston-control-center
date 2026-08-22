import Foundation

/// A tiny thread safe box so the relay can read health from its own queue
/// without reaching into main actor state.
final class HealthBox {
    private var value: [[String: Any]] = []
    private let lock = NSLock()
    func set(_ v: [[String: Any]]) { lock.lock(); value = v; lock.unlock() }
    func get() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return value }
}

@MainActor
final class Controller: ObservableObject {
    let store: Store
    private let capture = Capture()
    private let relay = Relay()
    private let health = HealthBox()
    let ollama = Ollama()

    /* Local extraction state. The contract comes from the dashboard at start;
       the prior ring gives the model the same three lines of channel context
       the cloud extractor gets; the serial queue keeps transmissions in the
       order the radio said them, because extraction takes a second or three
       and two finishing out of order would swap history. */
    private var contract: ExtractContract?
    private var exPrior: [String: [String]] = [:]
    private let exQueue = DispatchQueue(label: "relay.extract")
    private var exWarned = false

    @Published var testResult: String?
    @Published var testOK = false

    /* Kept here rather than in the extension below, since only a type body can
       hold stored properties. */
    var samples: [LoadSample] = []
    var loadTimer: Timer?
    var runningSince: Date?

    /* Monitor-only taps for hearing an aux port while capture is stopped.
       While capture runs, listening rides the capture's own tap instead, so
       these exist only in the stopped state and are folded into the real
       taps at every start. */
    private var previews: [String: AuxInputTap] = [:]

    init(store: Store) {
        self.store = store
        relay.healthProvider = { [health] in health.get() }
        relay.onState = { [weak self] state, depth in
            self?.store.relayState = state
            self?.store.queued = depth
        }
        relay.onLog = { [weak self] line in self?.store.note(line) }
        capture.onEvent = { [weak self] e in self?.handle(e) }
    }

    /* --------------------------------------------------------------- run --- */

    func start() {
        guard !store.running else { return }
        if let problem = Capture.toolingProblem {
            store.note("cannot start: \(problem)")
            return
        }
        guard store.readyToStart else {
            store.note("cannot start: add at least one feed with a URL, and fill in the ingest token in Settings")
            return
        }

        store.save()
        relay.endpoint = store.endpoint.trimmingCharacters(in: .whitespaces)
        relay.token = store.ingestToken.trimmingCharacters(in: .whitespaces)
        relay.machine = store.machine
        relay.start()

        /* The extraction contract, fetched fresh at every capture start and
           cached against the dashboard being unreachable. Local mode with no
           contract at all degrades to plain relaying, which the server treats
           exactly like a relay that never learned to think. */
        exWarned = false
        if store.extractMode == "local" {
            Ollama.fetchContract(endpoint: relay.endpoint, token: relay.token) { [weak self] c in
                DispatchQueue.main.async {
                    self?.contract = c
                    self?.ollama.contractVersion = c?.version
                    self?.store.note(c != nil
                        ? "extraction contract v\(c!.version), reading locally with \(self?.store.extractModel ?? "?")"
                        : "no extraction contract reachable, transmissions ship raw and the dashboard reads them")
                }
            }
            ollama.refresh()
        }

        /* Any ear that was on the port through a preview tap moves onto the
           capture's own tap now; two sessions must never hold one device. */
        for (_, t) in previews { t.stop() }
        previews.removeAll()

        var o = Capture.Options()
        o.sources = store.sources
        o.bfUser = store.bfUser.trimmingCharacters(in: .whitespaces)
        o.bfPass = store.bfPass.trimmingCharacters(in: .whitespaces)
        o.segmentSeconds = store.segmentSeconds
        o.silenceGate = store.silenceGate
        o.modelID = store.modelID
        capture.start(o)
        for id in store.auxListening { capture.setAuxMonitor(true, id: id) }

        for s in store.sources {
            store.statuses[s.id] = SourceStatus(state: s.enabled ? "connecting" : "off")
        }
        store.running = true
        samples.removeAll()
        runningSince = Date()
        beginLoadTicker()
        pushHealth()

        let live = store.liveFeedCount
        let model = SpeechModel.find(store.modelID).label
        store.note("capture started, \(live) feed\(live == 1 ? "" : "s") on \(model), sending to \(store.endpoint)")
    }

    func stop() {
        guard store.running else { return }
        capture.stop()
        relay.stop()
        store.running = false
        endLoadTicker()
        runningSince = nil
        samples.removeAll()
        store.load = LoadReading()
        for s in store.sources { store.statuses[s.id]?.state = "idle" }
        store.relayState = "idle"
        store.note("capture stopped")

        /* Stopping capture should not stop the operator's ear. Any port that
           was playing aloud keeps playing, through a bare monitor tap. */
        for s in store.sources
        where s.isAuxIn && store.auxListening.contains(s.id) && !s.deviceUID.isEmpty {
            spawnPreview(s)
        }
    }

    func toggle() { store.running ? stop() : start() }

    /* ---------------------------------------------------------- aux listen --- */

    /* Hearing the port through this Mac's speakers. While capture runs the
       sound comes off the same tap whisper reads, so what you hear is what
       the transcriber hears. While capture is stopped a bare tap is opened
       for the ear alone: no segments, no whisper, just the cable made
       audible so the level can be set before going live. */
    func setAuxListen(_ on: Bool, for s: Source) {
        if on { store.auxListening.insert(s.id) } else { store.auxListening.remove(s.id) }
        if store.running {
            capture.setAuxMonitor(on, id: s.id)
            return
        }
        if on {
            guard !s.deviceUID.isEmpty else { return }
            spawnPreview(s)
        } else {
            previews[s.id]?.stop()
            previews[s.id] = nil
        }
    }

    private func spawnPreview(_ s: Source) {
        previews[s.id]?.stop()
        let tap = AuxInputTap()
        tap.setMonitor(true)
        tap.onNotice = { [weak self] line in
            DispatchQueue.main.async { self?.store.note("[\(s.slug)] \(line)") }
        }
        tap.onFailure = { [weak self] why in
            DispatchQueue.main.async {
                guard let self else { return }
                self.store.note("[\(s.slug)] listen: \(why)")
                self.store.auxListening.remove(s.id)
                self.previews[s.id]?.stop()
                self.previews[s.id] = nil
            }
        }
        previews[s.id] = tap
        tap.start(deviceUID: s.deviceUID)
    }

    func testConnection() {
        testResult = "checking ..."
        testOK = false
        relay.endpoint = store.endpoint.trimmingCharacters(in: .whitespaces)
        relay.token = store.ingestToken.trimmingCharacters(in: .whitespaces)
        relay.machine = store.machine
        relay.test { [weak self] ok, message in
            self?.testOK = ok
            self?.testResult = message
        }
    }

    /* ------------------------------------------------------------ events --- */

    private func handle(_ e: CaptureEvent) {
        switch e {
        case .state(let id, let s):
            store.statuses[id, default: SourceStatus()].state = s
        case .audio(let id, let peak):
            store.statuses[id, default: SourceStatus()].peak = peak
            store.statuses[id, default: SourceStatus()].lastAudioAt = Date()
        case .segment(let id):
            store.statuses[id, default: SourceStatus()].segments += 1
        case .gated(let id):
            store.statuses[id, default: SourceStatus()].gated += 1
        case .text(let id, let text, let clip):
            var st = store.statuses[id] ?? SourceStatus()
            st.clips += 1
            st.lastText = text
            st.lastTextAt = Date()
            st.lastError = nil
            st.state = "live"
            store.statuses[id] = st
            if let s = store.sources.first(where: { $0.id == id }) {
                dispatch(source: s, text: text, clip: clip)
                store.note("[\(s.label.isEmpty ? s.slug : s.label)] \(text)")
            }
        case .failed(let id, let reason):
            store.statuses[id, default: SourceStatus()].lastError = reason
            store.statuses[id, default: SourceStatus()].failed += 1
            if let s = store.sources.first(where: { $0.id == id }) {
                store.note("[\(s.label.isEmpty ? s.slug : s.label)] \(reason)")
            }
        case .log(let line):
            store.note(line)
        case .timing(_, let audio, let wall):
            record(audio: audio, wall: wall)
        }
        pushHealth()
    }

    /* One transmission leaves this Mac. In cloud mode it goes straight onto
       the relay queue and the dashboard does the reading. In local mode it
       stops at Ollama first, ten seconds at most, and ships with whatever the
       model understood; a slow or dead Ollama costs the words nothing but the
       wait, because the server's ladder is directly below. */
    private func dispatch(source s: Source, text: String, clip: Data?) {
        let mode = store.extractMode, model = store.extractModel
        guard mode == "local", let c = contract else {
            if mode == "local" && !exWarned {
                exWarned = true
                store.note("local extraction has no contract, shipping raw until the next start")
            }
            relay.enqueue(src: s.slug, city: s.city, scope: s.coverage.joined(separator: ", "), text: text, clip: clip)
            return
        }
        let prior = exPrior[s.slug] ?? []
        exPrior[s.slug] = Array((prior + [String(text.prefix(220))]).suffix(3))
        let relay = self.relay
        exQueue.async {
            let sem = DispatchSemaphore(value: 0)
            var got: String?
            Ollama.extract(text: text, prior: prior, contract: c, model: model, timeout: 10) {
                got = $0; sem.signal()
            }
            _ = sem.wait(timeout: .now() + 11)
            if got == nil {
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.exWarned else { return }
                    self.exWarned = true
                    self.store.note("Ollama did not answer, transmissions ship raw and the dashboard reads them")
                }
            }
            relay.enqueue(src: s.slug, city: s.city, scope: s.coverage.joined(separator: ", "),
                          text: text, clip: clip, ex: got)
        }
    }

    /* The dashboard already understands this shape, so the new app reports the
       same health block the old agent did. */
    private func pushHealth() {
        let iso = ISO8601DateFormatter()
        /* A half typed row is not a feed. Reporting one puts a phantom entry on
           the dashboard that nobody can explain, so only rows that are actually
           pointed at something are worth telling the cloud about. */
        health.set(store.sources.filter { $0.isConfigured }.map { s in
            let st = store.status(s)
            return [
                "id": s.slug,
                "kind": s.isAppAudio ? "app"
                    : (s.isBroadcastify ? "broadcastify" : "stream"),
                "city": s.city,
                "scope": s.coverage,
                "label": s.label,
                "status": s.enabled ? st.state : "off",
                "clips": st.clips,
                "segs": st.segments,
                "gated": st.gated,
                "failed": st.failed,
                "lastAudioAt": st.lastAudioAt.map { iso.string(from: $0) } as Any,
                "lastTextAt": st.lastTextAt.map { iso.string(from: $0) } as Any,
                "lastError": st.lastError as Any,
                "gate": store.silenceGate,
                "peakLast": st.peak,
            ]
        })
    }
}

/* -------------------------------------------------------------- load --- */

/* The question this answers is "can I throw more feeds in", and the honest way
   to answer it is to time the work rather than to read a processor gauge.
   Whisper decodes one clip at a time here, so every clip that arrives has to
   wait for the one in front of it. Measure what share of the clock is spent
   decoding, divide by the number of feeds, and what is left over says how many
   more feeds would fit before the text starts arriving late. */
extension Controller {

    struct LoadSample { let at: Date; let audio: Double; let wall: Double }

    /// Two minutes is long enough to ride out a quiet stretch on one feed and
    /// short enough to notice a Mac falling behind while it happens.
    static var loadWindow: Double { 120 }

    func record(audio: Double, wall: Double) {
        samples.append(LoadSample(at: Date(), audio: audio, wall: wall))
        recomputeLoad()
    }

    func beginLoadTicker() {
        endLoadTicker()
        /* Events alone are not enough. If the radio goes quiet the last reading
           would sit there claiming the Mac is busy, so the clock keeps ticking
           on its own and lets the number fall back down. */
        loadTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
            Task { @MainActor [weak self] in self?.recomputeLoad() }
        }
    }

    func endLoadTicker() {
        loadTimer?.invalidate()
        loadTimer = nil
    }

    func recomputeLoad() {
        let now = Date()
        let cutoff = now.addingTimeInterval(-Controller.loadWindow)
        samples.removeAll { $0.at < cutoff }

        var r = LoadReading()
        r.feeds = store.liveFeedCount
        r.queueDepth = capture.work.operationCount
        r.modelMB = SpeechModel.find(store.modelID).megabytes
        r.memoryGB = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824

        /* Per core, so the number reads the same on a four core Mini and a ten
           core MacBook. Above one means the machine is oversubscribed. */
        var avg = [Double](repeating: 0, count: 3)
        getloadavg(&avg, 3)
        let cores = Double(ProcessInfo.processInfo.activeProcessorCount)
        r.loadAverage = cores > 0 ? avg[0] / cores : avg[0]

        switch ProcessInfo.processInfo.thermalState {
        case .nominal:  r.thermal = "nominal"
        case .fair:     r.thermal = "fair"
        case .serious:  r.thermal = "serious"
        case .critical: r.thermal = "critical"
        @unknown default: r.thermal = "unknown"
        }

        /* A Mac that started ten seconds ago has not had two minutes to be busy
           in, so the divisor is however long it has actually been running. The
           floor keeps the first clip from reading as four hundred percent. */
        let elapsed = runningSince.map { now.timeIntervalSince($0) } ?? 0
        let span = max(20, min(Controller.loadWindow, elapsed))
        if !samples.isEmpty {
            let wall = samples.reduce(0) { $0 + $1.wall }
            let audio = samples.reduce(0) { $0 + $1.audio }
            r.duty = min(1, wall / span)
            r.speed = wall > 0 ? audio / wall : 0
            r.clips = samples.count
            r.measured = true
        } else if store.running && elapsed > 45 {
            /* Running, nothing decoded, and long enough that this is real
               quiet rather than a slow start. */
            r.measured = true
        }
        store.load = r
    }
}
