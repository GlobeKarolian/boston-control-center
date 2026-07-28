import Foundation
import Combine

// Everything that talks to launchd, to the shell, or to the agent's files lives
// here. The views never run a process themselves.

enum Shell {
    // Read the pipe to EOF before waiting on the process. launchctl print emits
    // several kilobytes and a full pipe buffer with a pending waitUntilExit is a
    // deadlock.
    static func run(_ path: String, _ args: [String], timeout: Double = 60) -> (code: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return (-1, "could not run \(path): \(error.localizedDescription)") }

        let deadline = Date().addingTimeInterval(timeout)
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate() }
        p.waitUntilExit()
        return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    static var uid: String { String(getuid()) }
}

enum Launchd {
    static let label = "com.bostonglobe.bcc-agent"
    static var target: String { "gui/\(Shell.uid)/\(label)" }
    static var domain: String { "gui/\(Shell.uid)" }
    static let bin = "/bin/launchctl"

    // Bootstrapped and running are two different questions, and only the second
    // one decides what the button says. A fresh pkg install leaves the job sitting
    // in launchd with nothing executing behind it, and the agent also exits 0 on
    // purpose when its config is missing so launchd stops retrying. Both of those
    // read as "state = not running", and both of them mean Start.
    static func probe() -> (loaded: Bool, running: Bool) {
        let r = Shell.run(bin, ["print", target], timeout: 10)
        guard r.code == 0 else { return (false, false) }
        if r.out.contains("state = running") { return (true, true) }
        if r.out.contains("state = not running") { return (true, false) }
        let hasPid = r.out.split(separator: "\n").contains {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix("pid = ")
        }
        return (true, hasPid)
    }

    // Start is three steps and all three are needed. enable clears any earlier
    // disable, which persists in launchd's override database across reboots.
    // bootstrap loads the job. kickstart -k starts it now rather than at the
    // next login, and the -k restarts it if it was already up on an old config.
    static func start() -> String {
        var log: [String] = []
        let e = Shell.run(bin, ["enable", target], timeout: 15)
        log.append("enable -> \(e.code)")
        let b = Shell.run(bin, ["bootstrap", domain, Paths.plist.path], timeout: 30)
        // 37 is EALREADY, the job was already bootstrapped. That is a success here.
        log.append("bootstrap -> \(b.code) \(b.out.trimmingCharacters(in: .whitespacesAndNewlines))")
        let k = Shell.run(bin, ["kickstart", "-k", target], timeout: 30)
        log.append("kickstart -> \(k.code) \(k.out.trimmingCharacters(in: .whitespacesAndNewlines))")
        return log.joined(separator: "\n")
    }

    // bootout on its own does not survive a reboot, because the plist stays in
    // /Library/LaunchAgents and RunAtLoad is true, so launchd starts it again at
    // the next login. disable is the part that makes a stop mean stop.
    static func stop() -> String {
        var log: [String] = []
        let o = Shell.run(bin, ["bootout", target], timeout: 30)
        log.append("bootout -> \(o.code) \(o.out.trimmingCharacters(in: .whitespacesAndNewlines))")
        let d = Shell.run(bin, ["disable", target], timeout: 15)
        log.append("disable -> \(d.code)")
        return log.joined(separator: "\n")
    }
}

enum RunState: Equatable {
    case notInstalled
    case stopped
    case starting
    case capturing
    case stalled

    var title: String {
        switch self {
        case .notInstalled: return "Agent not installed"
        case .stopped:      return "Stopped"
        case .starting:     return "Starting"
        case .capturing:    return "Capturing"
        case .stalled:      return "Not reporting"
        }
    }
}

@MainActor
final class AgentControl: ObservableObject {
    @Published var feeds: [Feed] = []
    @Published var settings = Settings()
    @Published var status: AgentStatus?
    @Published var logText = ""
    @Published var state: RunState = .stopped
    @Published var note: String?
    @Published var busy = false
    @Published var hasIngestToken = false
    @Published var hasBroadcastifyLogin = false

    private var timer: Timer?
    private var loaded = false
    private var running = false
    private var tick = 0
    private var lastStartAt: Date?
    private var appliedConfig: Data?

    // MARK: load

    func boot() {
        Paths.ensureDirs()
        if let saved = Disk.readJSON(UIState.self, at: Paths.uiState) {
            feeds = saved.feeds
            settings = saved.settings
        } else {
            var starter = UIState.starter
            // A machine that already went through bcc-setup has a working config.
            // Adopt it rather than overwriting his choices with the defaults.
            if let adopted = importExistingConfig() {
                starter = adopted
            }
            feeds = starter.feeds
            settings = starter.settings
            saveUIState()
        }
        appliedConfig = try? Data(contentsOf: Paths.config)
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    // Reads a config.json written by bcc-setup and turns it back into a catalog
    // the UI can show. Labels are not in the agent contract, so known ids get a
    // readable name and anything else gets its id.
    private func importExistingConfig() -> UIState? {
        guard let data = try? Data(contentsOf: Paths.config),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = root["sources"] as? [[String: Any]], !raw.isEmpty
        else { return nil }

        let names = ["bostonfire": "Boston Fire", "bostonems": "Boston EMS",
                     "cambridge": "Cambridge", "msp": "Mass State Police",
                     "bpd": "Boston Police, browser tab"]
        var out: [Feed] = []
        for s in raw {
            let id = String(describing: s["id"] ?? "")
            if id.isEmpty { continue }
            let city = s["city"] as? String ?? "Boston"
            let label = names[id] ?? id
            if (s["kind"] as? String) == "audiotap" {
                var f = Feed.tap(id, label, city, s["app"] as? String ?? "", on: true)
                f.system = (s["system"] as? Bool) ?? false
                out.append(f)
            } else {
                var feedId = ""
                if let n = s["feed"] as? NSNumber { feedId = n.stringValue }
                else if let t = s["feed"] as? String { feedId = t }
                out.append(.broadcastify(id, label, city, feedId, on: true))
            }
        }
        var set = Settings()
        if let m = root["machine"] as? String { set.machine = m }
        if let e = root["endpoint"] as? String, e.hasPrefix("http") { set.endpoint = e }
        if let w = root["whisperModel"] as? String { set.whisperModel = w }
        if let s = root["segmentSeconds"] as? NSNumber { set.segmentSeconds = s.intValue }
        if let g = root["silenceGate"] as? NSNumber { set.silenceGate = g.doubleValue }

        // Anything in the starter catalog he does not currently run stays visible
        // and switched off, so swapping a feed in is one click.
        let have = Set(out.map(\.id))
        for var f in UIState.starter.feeds where !have.contains(f.id) {
            f.enabled = false
            out.append(f)
        }
        return UIState(feeds: out, settings: set)
    }

    // MARK: poll

    func refresh() {
        status = Disk.readJSON(AgentStatus.self, at: Paths.status)
        logText = Disk.tail(Paths.log, lines: 500)
        hasIngestToken = Disk.exists(Paths.ingestToken)
        hasBroadcastifyLogin = Disk.exists(Paths.broadcastifyLogin)

        if !Disk.exists(Paths.plist) || !Disk.exists(Paths.agentBin.appendingPathComponent("bcc-agent.js")) {
            state = .notInstalled
            return
        }
        // launchctl print emits several kilobytes, so it runs every third tick
        // rather than every one. Six seconds is fast enough for a status light.
        tick += 1
        if !busy && tick % 3 == 1 {
            let p = Launchd.probe()
            loaded = p.loaded
            running = p.running
        }

        guard loaded else { state = .stopped; return }
        // The agent takes a moment to come up after Start, and flashing back to
        // Stopped in that gap reads as a button that did nothing.
        if let t = lastStartAt, Date().timeIntervalSince(t) < 20 { state = .starting; return }
        // Loaded with nothing running is what a fresh install looks like, and what
        // an agent that quit over a missing config looks like. Both mean Start.
        guard running || busy else { state = .stopped; return }
        if let s = status, s.isFresh { state = .capturing }
        else if let s = status, let d = s.updatedDate, Date().timeIntervalSince(d) < 600 { state = .stalled }
        else { state = .starting }
    }

    // MARK: config

    var enabledFeeds: [Feed] { feeds.filter { $0.enabled && $0.problem == nil } }

    var needsBroadcastifyLogin: Bool {
        enabledFeeds.contains { $0.kind == .broadcastify }
    }

    // The only shape the agent accepts. Keys the agent does not read are not
    // written, which is why this is built by hand rather than encoded from Feed.
    func agentConfigData() throws -> Data {
        var sources: [[String: Any]] = []
        for f in enabledFeeds {
            var s: [String: Any] = ["id": f.id, "city": f.city, "kind": f.kind.rawValue]
            switch f.kind {
            case .broadcastify:
                s["feed"] = Int(f.feed) ?? 0
            case .audiotap:
                if f.system { s["system"] = true } else { s["app"] = f.app }
            }
            sources.append(s)
        }
        let root: [String: Any] = [
            "machine": settings.machine,
            "endpoint": settings.endpoint,
            "sources": sources,
            "segmentSeconds": settings.segmentSeconds,
            "silenceGate": settings.silenceGate,
            // The agent's key for the tap gate is silenceGateTap. A browser tap
            // runs far quieter than a Broadcastify stream, so the two gates are
            // separate numbers and this one is not a typo for the other.
            "silenceGateTap": settings.audiotapGate,
            "whisperModel": settings.whisperModel,
        ]
        return try JSONSerialization.data(withJSONObject: root,
                                          options: [.prettyPrinted, .sortedKeys])
    }

    var configChanged: Bool {
        guard let now = try? agentConfigData() else { return false }
        return now != appliedConfig
    }

    func saveUIState() {
        try? Disk.writeJSON(UIState(feeds: feeds, settings: settings), to: Paths.uiState)
    }

    func writeConfig() throws {
        let data = try agentConfigData()
        try Disk.write(data, to: Paths.config, mode: 0o644)
        appliedConfig = data
    }

    // MARK: lifecycle

    var blocker: String? {
        if state == .notInstalled { return "Install BCC-Agent.pkg first" }
        if enabledFeeds.isEmpty { return "Turn on at least one feed" }
        if settings.endpoint.isEmpty { return "Set the dashboard address in Settings" }
        if !hasIngestToken { return "Add the ingest key in Settings" }
        if needsBroadcastifyLogin && !hasBroadcastifyLogin { return "Add the Broadcastify login in Settings" }
        return nil
    }

    func startCapture() async {
        guard blocker == nil else { note = blocker; return }
        busy = true; note = nil
        do { try writeConfig() } catch { note = "Could not write the config: \(error.localizedDescription)"; busy = false; return }
        saveUIState()
        let out = await Task.detached { Launchd.start() }.value
        loaded = true
        running = true
        lastStartAt = Date()
        tick = 0
        busy = false
        state = .starting
        note = out.contains("kickstart -> 0") ? nil : "launchd said:\n\(out)"
        refresh()
    }

    func stopCapture() async {
        busy = true; note = nil
        let out = await Task.detached { Launchd.stop() }.value
        loaded = false
        running = false
        lastStartAt = nil
        tick = 0
        busy = false
        state = .stopped
        if !out.contains("disable -> 0") { note = "launchd said:\n\(out)" }
        refresh()
    }

    // Apply is a restart, because the agent reads its config once at boot.
    func applyChanges() async {
        guard blocker == nil else { note = blocker; return }
        busy = true; note = nil
        do { try writeConfig() } catch { note = "Could not write the config: \(error.localizedDescription)"; busy = false; return }
        saveUIState()
        let out = await Task.detached { Launchd.start() }.value
        loaded = true
        running = true
        lastStartAt = Date()
        tick = 0
        busy = false
        state = .starting
        if !out.contains("kickstart -> 0") { note = "launchd said:\n\(out)" }
        refresh()
    }

    func runDoctor() async -> String {
        let paths = ["/usr/local/bin/bcc-doctor",
                     Paths.agentBin.appendingPathComponent("bcc-doctor").path]
        guard let p = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return "bcc-doctor is not installed. Install BCC-Agent.pkg."
        }
        let r = await Task.detached { Shell.run(p, [], timeout: 120) }.value
        return Redact.apply(r.out)
    }

    // The setup script builds the Python environment and pulls the Whisper model.
    // That is minutes of work and belongs in a window the user can watch, so the
    // app hands it to Terminal rather than swallowing it.
    func openSetupInTerminal() {
        let paths = ["/usr/local/bin/bcc-setup",
                     Paths.agentBin.appendingPathComponent("bcc-setup").path]
        guard let p = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            note = "bcc-setup is not installed. Install BCC-Agent.pkg."
            return
        }
        _ = Shell.run("/usr/bin/open", ["-a", "Terminal", p], timeout: 15)
    }

    // Posts an empty item list with the saved key. It proves the address and the
    // key are right without inventing a single incident.
    func testConnection() async -> String {
        let ep = settings.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ep.hasPrefix("http"), let base = URL(string: ep) else {
            return "The dashboard address needs to start with https://"
        }
        guard let raw = try? String(contentsOf: Paths.ingestToken, encoding: .utf8) else {
            return "No ingest key is saved yet."
        }
        var req = URLRequest(url: base.appendingPathComponent("api/ingest"))
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("Bearer " + raw.trimmingCharacters(in: .whitespacesAndNewlines),
                     forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(
            withJSONObject: ["machine": settings.machine, "items": []])
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let body = String(data: data, encoding: .utf8) ?? ""
            switch code {
            case 200: return "Connected. The dashboard accepted this machine."
            case 401: return "The dashboard refused the key. Check the ingest key, and check it is in INGEST_TOKENS on Vercel."
            case 404: return "That address answered, but there is no ingest endpoint on it. Check the dashboard address."
            default:  return "The dashboard answered \(code). " + Redact.apply(String(body.prefix(200)))
            }
        } catch {
            return "Could not reach that address. \(error.localizedDescription)"
        }
    }

    func revealLog() {
        _ = Shell.run("/usr/bin/open", ["-R", Paths.log.path], timeout: 10)
    }

    // MARK: secrets, typed by the user and never read back

    func saveIngestToken(_ t: String) {
        guard !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        try? Disk.writeSecret(t, to: Paths.ingestToken)
        hasIngestToken = Disk.exists(Paths.ingestToken)
    }

    func saveBroadcastifyLogin(user: String, pass: String) {
        let u = user.trimmingCharacters(in: .whitespacesAndNewlines)
        let p = pass.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !u.isEmpty, !p.isEmpty else { return }
        try? Disk.writeSecret("\(u)\n\(p)", to: Paths.broadcastifyLogin)
        hasBroadcastifyLogin = Disk.exists(Paths.broadcastifyLogin)
    }

    // MARK: feed edits

    func toggle(_ feed: Feed) {
        guard let i = feeds.firstIndex(where: { $0.id == feed.id }) else { return }
        feeds[i].enabled.toggle()
        saveUIState()
    }

    func update(_ feed: Feed) {
        guard let i = feeds.firstIndex(where: { $0.id == feed.id }) else { feeds.append(feed); saveUIState(); return }
        feeds[i] = feed
        saveUIState()
    }

    func add(_ feed: Feed) {
        var f = feed
        var n = 2
        while feeds.contains(where: { $0.id == f.id }) { f.id = "\(feed.id)\(n)"; n += 1 }
        feeds.append(f)
        saveUIState()
    }

    func remove(_ ids: Set<String>) {
        feeds.removeAll { ids.contains($0.id) }
        saveUIState()
    }

    func statusFor(_ id: String) -> SourceStatus? {
        status?.sources?.first { $0.id == id }
    }
}
