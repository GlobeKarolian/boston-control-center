import Foundation
/* -------------------------------------------------------------- secrets --- */
/* Secrets stay out of the config file and live in their own folder, owner read
   and write only.

   The login keychain was the first choice and it was wrong. This app is signed
   ad hoc, so its signature changes with every build, and macOS treats each new
   build as a different program asking for another program's saved password.
   That puts a system dialog on screen before the window ever draws, and on a
   Mac where nobody is watching it simply hangs. A file with mode 0600 in the
   app's own support folder has the same reach for anything running as this
   user, and it never stops to ask. */
enum Secrets {
    private static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("ScannerRelay/secrets", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: base, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        return base
    }()

    private static func file(_ key: String) -> URL {
        dir.appendingPathComponent(key.replacingOccurrences(of: "/", with: "-"))
    }

    static func set(_ value: String, for key: String) {
        let f = file(key)
        guard !value.isEmpty else { try? FileManager.default.removeItem(at: f); return }
        try? Data(value.utf8).write(to: f, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                               ofItemAtPath: f.path)
    }

    static func get(_ key: String) -> String {
        guard let d = try? Data(contentsOf: file(key)),
              let s = String(data: d, encoding: .utf8) else { return "" }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/* --------------------------------------------------------------- sources --- */
struct Source: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var label: String = ""
    var url: String = ""
    var city: String = "Boston"
    var enabled: Bool = true

    /* "stream" pulls from a URL. "app" taps the sound another application is
       making, which is the only way to reach a police feed that lives behind a
       web player instead of a Broadcastify address. */
    var kind: String = "stream"
    var bundleID: String = ""

    /* Which towns this feed actually covers. Every town in Massachusetts has a
       Main St, so a street name off a scanner means nothing without knowing
       which municipalities the transmitter serves. A city feed names one town.
       A state police feed names many, and street names from it should not be
       trusted to a point until the transcript says a town out loud. */
    var scope: String = ""

    var isAppAudio: Bool { kind == "app" }

    /* Boston Police, straight off the city's own radio socket. It reuses the
       url field to hold the channel id, so a feed is still one row with one
       address in it, and the app tap it replaces needed a browser left open
       on a machine nobody could touch. */
    var isRapidSOS: Bool { kind == "rapidsos" }

    var coverage: [String] {
        let raw = scope.isEmpty ? city : scope
        return raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// A half typed row is not a feed, and should not start or be reported.
    var isConfigured: Bool {
        isAppAudio
            ? !bundleID.trimmingCharacters(in: .whitespaces).isEmpty
            : !url.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /* Accepts whatever a person actually has in their clipboard: the listen page,
       the raw audio URL, or just the feed number. Anything else that looks like a
       URL is passed through untouched, so a non Broadcastify stream works too. */
    static func normalize(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return s }
        if s.allSatisfy({ $0.isNumber }) {
            return "https://www.broadcastify.com/listen/feed/\(s)"
        }
        /* The old audio.broadcastify.com address was retired. Anything still
           pointing at it gets moved to the listen page, which is where the
           playlist and the listening token now come from. */
        if let r = s.range(of: "audio\\.broadcastify\\.com/[0-9]+",
                           options: [.regularExpression, .caseInsensitive]) {
            let digits = s[r].split(separator: "/").last.map(String.init) ?? ""
            if !digits.isEmpty { return "https://www.broadcastify.com/listen/feed/\(digits)" }
        }
        if let r = s.range(of: "broadcastify\\.com/listen/feed/[0-9]+",
                           options: [.regularExpression, .caseInsensitive]) {
            let digits = s[r].split(separator: "/").last.map(String.init) ?? ""
            if !digits.isEmpty { return "https://www.broadcastify.com/listen/feed/\(digits)" }
        }
        if s.range(of: "^https?://", options: .regularExpression) != nil { return s }
        return "https://\(s)"
    }

    var isBroadcastify: Bool {
        url.range(of: "broadcastify.com", options: .caseInsensitive) != nil
    }

    /* A stable, readable key for the dashboard. The label drives it so a feed
       renamed in the app shows up renamed on the map. */
    var slug: String {
        let base = label.isEmpty ? "feed" : label
        let cleaned = base.lowercased().map { ch -> Character in
            (ch.isLetter || ch.isNumber) ? ch : "-"
        }
        var out = String(cleaned)
        while out.contains("--") { out = out.replacingOccurrences(of: "--", with: "-") }
        return out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

/* Decoding is written out by hand rather than synthesized. A config file saved
   by an earlier build has no kind, no bundle identifier and no scope in it, and
   the synthesized version treats a missing key as a broken file. That would
   quietly wipe every feed the operator had already set up. Living in an
   extension keeps the memberwise initializer, which the rest of the app uses. */
extension Source {
    enum CodingKeys: String, CodingKey {
        case id, label, url, city, enabled, kind, bundleID, scope
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        url = try c.decodeIfPresent(String.self, forKey: .url) ?? ""
        city = try c.decodeIfPresent(String.self, forKey: .city) ?? "Boston"
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "stream"
        bundleID = try c.decodeIfPresent(String.self, forKey: .bundleID) ?? ""
        scope = try c.decodeIfPresent(String.self, forKey: .scope) ?? ""
    }
}

struct SourceStatus: Equatable {
    var state: String = "idle"          // idle, connecting, live, error, off
    var clips = 0
    var segments = 0
    var gated = 0
    var lastText = ""
    var lastTextAt: Date?
    var lastAudioAt: Date?
    var lastError: String?
    var peak: Double = 0
}

/* ---------------------------------------------------------------- config --- */
private struct Persisted: Codable {
    var sources: [Source] = []
    var endpoint = "https://boston-control-center.vercel.app"
    var machine = ""
    var segmentSeconds: Double = 15
    var silenceGate: Double = 0.01
    var modelID = SpeechModel.bundledID
    /* Where the reading happens: "cloud" spends the dashboard's model budget,
       "local" spends this Mac's electricity. Two fields, same decode-tolerant
       story as modelID: configs written before they existed read as cloud. */
    var extractMode = "cloud"
    var extractModel = LocalModel.recommendedID
}

/* Same reason as Source: a file written before the model picker existed has no
   modelID in it, and that must not read as a corrupt config. */
extension Persisted {
    enum CodingKeys: String, CodingKey {
        case sources, endpoint, machine, segmentSeconds, silenceGate, modelID,
             extractMode, extractModel
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        sources = try c.decodeIfPresent([Source].self, forKey: .sources) ?? []
        endpoint = try c.decodeIfPresent(String.self, forKey: .endpoint)
            ?? "https://boston-control-center.vercel.app"
        machine = try c.decodeIfPresent(String.self, forKey: .machine) ?? ""
        segmentSeconds = try c.decodeIfPresent(Double.self, forKey: .segmentSeconds) ?? 15
        silenceGate = try c.decodeIfPresent(Double.self, forKey: .silenceGate) ?? 0.01
        modelID = try c.decodeIfPresent(String.self, forKey: .modelID) ?? SpeechModel.bundledID
        extractMode = try c.decodeIfPresent(String.self, forKey: .extractMode) ?? "cloud"
        extractModel = try c.decodeIfPresent(String.self, forKey: .extractModel) ?? LocalModel.recommendedID
    }
}

@MainActor
final class Store: ObservableObject {
    @Published var sources: [Source] = []
    @Published var endpoint = "https://boston-control-center.vercel.app"
    @Published var machine = ""
    @Published var segmentSeconds: Double = 15
    @Published var silenceGate: Double = 0.01
    @Published var modelID = SpeechModel.bundledID
    @Published var extractMode = "cloud"
    @Published var extractModel = LocalModel.recommendedID

    /// What the transcriber is costing right now. Filled in by the controller.
    @Published var load = LoadReading()

    /// Applications this Mac could tap sound from, refreshed on demand.
    @Published var audioApps: [AudioApp] = []
    @Published var audioAppsProblem: String?

    @Published var ingestToken = "" { didSet { Secrets.set(ingestToken, for: "ingest") } }
    @Published var bfUser = ""      { didSet { Secrets.set(bfUser, for: "bf-user") } }
    @Published var bfPass = ""      { didSet { Secrets.set(bfPass, for: "bf-pass") } }

    @Published var running = false
    @Published var statuses: [String: SourceStatus] = [:]
    @Published var log: [String] = []
    @Published var queued = 0
    @Published var relayState = "idle"

    static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("ScannerRelay", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()
    private static let configURL = dir.appendingPathComponent("config.json")

    init() {
        var p = Persisted()
        if let d = try? Data(contentsOf: Self.configURL),
           let decoded = try? JSONDecoder().decode(Persisted.self, from: d) {
            p = decoded
        }
        sources = p.sources
        endpoint = p.endpoint
        segmentSeconds = p.segmentSeconds
        silenceGate = p.silenceGate
        modelID = p.modelID
        extractMode = p.extractMode
        extractModel = p.extractModel
        machine = p.machine.isEmpty ? Self.defaultMachineName() : p.machine
        ingestToken = Secrets.get("ingest")
        bfUser = Secrets.get("bf-user")
        bfPass = Secrets.get("bf-pass")
        for s in sources { statuses[s.id] = SourceStatus() }
        adoptOldSecrets()
    }

    /* A Mac that ran the earlier command line setup already has these on disk.
       Pick them up once so the first launch is not a scavenger hunt. Anything
       typed into the app afterwards wins, since this only fires when the slot
       is empty. */
    private func adoptOldSecrets() {
        let home = FileManager.default.homeDirectoryForCurrentUser

        func firstLine(_ url: URL, _ index: Int) -> String {
            guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return "" }
            let lines = raw.split(separator: "\n", omittingEmptySubsequences: false)
            guard index < lines.count else { return "" }
            return lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
        }

        if ingestToken.isEmpty {
            for p in [".bcc/.ingest_secret",
                      ".boston-control-center/.ingest_token_\(machine)"] {
                let t = firstLine(home.appendingPathComponent(p), 0)
                if !t.isEmpty { ingestToken = t; break }
            }
        }
        if bfUser.isEmpty || bfPass.isEmpty {
            let f = home.appendingPathComponent(".boston-control-center/.login")
            let u = firstLine(f, 0), pw = firstLine(f, 1)
            if !u.isEmpty && !pw.isEmpty { bfUser = u; bfPass = pw }
        }
    }

    static func defaultMachineName() -> String {
        let raw = ProcessInfo.processInfo.hostName
            .replacingOccurrences(of: ".local", with: "")
            .lowercased()
        let cleaned = raw.map { ($0.isLetter || $0.isNumber) ? $0 : "-" }
        var out = String(cleaned)
        while out.contains("--") { out = out.replacingOccurrences(of: "--", with: "-") }
        return out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    func save() {
        let p = Persisted(sources: sources, endpoint: endpoint, machine: machine,
                          segmentSeconds: segmentSeconds, silenceGate: silenceGate,
                          modelID: modelID, extractMode: extractMode, extractModel: extractModel)
        if let d = try? JSONEncoder().encode(p) { try? d.write(to: Self.configURL) }
    }

    func addSource() {
        let s = Source()
        sources.append(s)
        statuses[s.id] = SourceStatus()
        save()
    }

    func remove(_ s: Source) {
        sources.removeAll { $0.id == s.id }
        statuses[s.id] = nil
        save()
    }

    func status(_ s: Source) -> SourceStatus { statuses[s.id] ?? SourceStatus() }

    func note(_ line: String) {
        let t = DateFormatter.stamp.string(from: Date())
        log.append("\(t)  \(line)")
        if log.count > 500 { log.removeFirst(log.count - 500) }
    }

    var readyToStart: Bool {
        !ingestToken.isEmpty
            && !endpoint.isEmpty
            && sources.contains { $0.enabled && $0.isConfigured }
    }

    var liveFeedCount: Int {
        sources.filter { $0.enabled && $0.isConfigured }.count
    }

    /// Ask the system which applications are making sound. This is also what
    /// raises the one time screen recording prompt, so it runs on demand.
    func refreshAudioApps() {
        SystemAudio.running { [weak self] apps, problem in
            guard let self else { return }
            self.audioApps = apps
            self.audioAppsProblem = problem
            if let problem { self.note("could not list applications: \(problem)") }
        }
    }
}

extension DateFormatter {
    static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()
}

/* ------------------------------------------------------------------ load --- */

/* Whisper runs one clip at a time on purpose, so the honest measure of how busy
   this Mac is is not processor percentage. It is how much of the wall clock the
   transcriber spends transcribing. At one hundred percent the queue grows and
   text starts arriving late, which on a scanner is the same as not arriving at
   all. Because decoding is serial, the cost of a feed is close to linear, so
   the number measured with two feeds predicts what a third would cost. */
struct LoadReading: Equatable {
    var duty: Double = 0            // 0...1, share of the clock spent decoding
    var speed: Double = 0           // seconds of audio handled per second of compute
    var clips = 0                   // clips measured inside the window
    var feeds = 0                   // feeds running while it was measured
    var queueDepth = 0
    var loadAverage: Double = 0     // one minute average, per core
    var thermal = "nominal"
    var memoryGB: Double = 0
    var modelMB = 0
    var measured = false

    /* Eighty percent rather than a hundred. The last stretch is where a burst
       of chatter turns into a queue that never drains, and text that arrives
       four minutes after the call is text nobody can use. */
    static var ceiling: Double { 0.80 }

    /* How many feeds could be talking at the same instant before the text
       starts falling behind the radio. Speed is seconds of audio handled per
       second of work, so a model running ten times faster than real time can
       carry ten feeds talking at once, less the safety margin.

       This is the number that matters on the night Fenway lets out, because
       that is when every feed is busy at the same time. */
    var burstCeiling: Int {
        guard measured, speed > 0 else { return 0 }
        return max(0, Int(speed * LoadReading.ceiling))
    }

    /* Two different questions, and only one of them is safe to answer.

       The first is how many more feeds fit given the traffic this Mac has
       actually seen. Scanner feeds are quiet most of the day and quiet audio
       never reaches the transcriber, so that projection runs away: two silent
       Cambridge feeds make it look like eighty more would fit.

       The second is how many fit when they are all talking. That one is fixed
       by how much faster than real time the model runs, and it is the one that
       holds on a busy night. The screen shows the smaller of the two. */
    var headroom: Int { min(trafficHeadroom, burstHeadroom) }

    var burstHeadroom: Int { max(0, burstCeiling - feeds) }

    var trafficHeadroom: Int {
        guard measured, feeds > 0, duty > 0.02 else { return burstHeadroom }
        let perFeed = duty / Double(feeds)
        return max(0, Int((LoadReading.ceiling - duty) / perFeed))
    }

    var verdict: String {
        guard measured else {
            return "waiting on a first clip to measure against"
        }
        if duty >= 0.95 {
            return "at capacity, the queue is growing. Pick a smaller model, or move a feed to another Mac."
        }
        if duty >= LoadReading.ceiling {
            return "nearly full. One more feed would put the text behind the radio."
        }
        if speed <= 0 {
            return "the radio has been quiet, so there is nothing to time yet. Leave it running and the number will fill in on the first call."
        }
        let n = headroom
        let rate = String(format: "%.0f", speed)
        if n <= 0 {
            return "full at this model. It runs \(rate) times faster than real time, so about "
                + "\(burstCeiling) feeds talking at once is the most this Mac can carry, and there "
                + "are already \(feeds)."
        }
        return "room for about \(n) more feed\(n == 1 ? "" : "s"). That is the number that still "
            + "holds when every feed is busy at once, which is the night you actually need this. "
            + "The model runs \(rate) times faster than real time, so \(burstCeiling) simultaneously "
            + "busy feeds is the ceiling."
    }

    /* Green under half, amber approaching the ceiling, red past it. Crowding
       the burst ceiling counts as pressure even while the duty cycle is low,
       since a quiet radio is not the same as a Mac with room to spare. */
    var tone: Int {
        guard measured else { return 0 }
        let crowded = burstCeiling > 0 ? Double(feeds) / Double(burstCeiling) : 0
        if duty >= LoadReading.ceiling || crowded >= 1 { return 2 }
        if duty >= 0.50 || crowded >= 0.75 { return 1 }
        return 0
    }
}
