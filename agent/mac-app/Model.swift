import Foundation

// The agent already has a config contract and it is not going to change to suit
// a GUI. ~/.bcc/config.json is what bcc-agent.js reads, and it only ever
// contains sources that are switched on. Everything the UI needs on top of that
// (labels, the feeds you have configured but turned off, window state) lives
// beside it in ui-state.json, which the agent never opens.

enum FeedKind: String, Codable, CaseIterable, Identifiable {
    case broadcastify
    case audiotap
    var id: String { rawValue }
    var title: String {
        switch self {
        case .broadcastify: return "Broadcastify"
        case .audiotap:     return "App or browser audio"
        }
    }
}

struct Feed: Identifiable, Codable, Equatable, Hashable {
    var id: String
    var label: String
    var city: String
    var kind: FeedKind
    var feed: String      // broadcastify feed id
    var app: String       // audiotap: application name, matched as a family
    var system: Bool      // audiotap: everything the Mac is playing
    var enabled: Bool

    static func broadcastify(_ id: String, _ label: String, _ city: String, _ feed: String, on: Bool = false) -> Feed {
        Feed(id: id, label: label, city: city, kind: .broadcastify, feed: feed, app: "", system: false, enabled: on)
    }
    static func tap(_ id: String, _ label: String, _ city: String, _ app: String, on: Bool = false) -> Feed {
        Feed(id: id, label: label, city: city, kind: .audiotap, feed: "", app: app, system: false, enabled: on)
    }

    // The id is what the agent, the dashboard and the status file all key on, so
    // it stays short and alphanumeric no matter what gets typed as a label.
    static func slug(_ s: String) -> String {
        let kept = s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
        let out = String(String.UnicodeScalarView(kept))
        return out.isEmpty ? "feed" : String(out.prefix(24))
    }

    var subtitle: String {
        switch kind {
        case .broadcastify: return feed.isEmpty ? "no feed id" : "feed \(feed)"
        case .audiotap:     return system ? "whole output device" : (app.isEmpty ? "no app set" : app)
        }
    }

    // A feed the agent would choke on is a feed we refuse to write.
    var problem: String? {
        if label.trimmingCharacters(in: .whitespaces).isEmpty { return "needs a name" }
        if id.trimmingCharacters(in: .whitespaces).isEmpty { return "needs an id" }
        switch kind {
        case .broadcastify:
            if feed.trimmingCharacters(in: .whitespaces).isEmpty { return "needs a Broadcastify feed id" }
            if !feed.allSatisfy({ $0.isNumber }) { return "feed id should be digits only" }
        case .audiotap:
            if !system && app.trimmingCharacters(in: .whitespaces).isEmpty { return "needs an app name" }
        }
        return nil
    }
}

struct Settings: Codable, Equatable {
    var machine: String = Settings.defaultMachineName()
    var endpoint: String = "https://boston-control-center.vercel.app"
    var whisperModel: String = "small.en"
    var segmentSeconds: Int = 15
    var silenceGate: Double = 0.01
    var audiotapGate: Double = 0.0015

    // The Mac's own name comes back with whatever its owner typed in it, curly
    // apostrophes included, and this string travels to the dashboard as an
    // identifier. Keep it to plain letters, digits and hyphens.
    static func defaultMachineName() -> String {
        let raw = Host.current().localizedName ?? "mac"
        var out = ""
        for ch in raw.lowercased() {
            if ch.isASCII && (ch.isLetter || ch.isNumber) { out.append(ch) }
            else if !out.isEmpty && !out.hasSuffix("-") { out.append("-") }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out.isEmpty ? "mac" : out
    }
}

struct UIState: Codable {
    var feeds: [Feed]
    var settings: Settings

    static var starter: UIState {
        UIState(feeds: [
            .broadcastify("bostonfire", "Boston Fire",        "Boston",    "46343", on: true),
            .broadcastify("bostonems",  "Boston EMS",         "Boston",    "36636", on: true),
            .broadcastify("cambridge",  "Cambridge",          "Cambridge", "36665"),
            .broadcastify("msp",        "Mass State Police",  "Boston",    "3969"),
            .tap("bpd", "Boston Police, browser tab", "Boston", "Google Chrome"),
        ], settings: Settings())
    }
}

// MARK: - per source telemetry the agent writes

struct SourceStatus: Codable, Identifiable {
    var id: String
    var kind: String?
    var status: String?
    var clips: Int?
    var segs: Int?
    var gated: Int?
    var attempts: Int?
    var lastAudioAt: String?
    var lastTextAt: String?
    var lastError: String?
    var peakLast: Double?
    var peakMax: Double?
}

struct AgentStatus: Codable {
    var machine: String?
    var endpoint: String?
    var pid: Int?
    var startedAt: String?
    var updatedAt: String?
    var queued: Int?
    var sources: [SourceStatus]?

    var updatedDate: Date? { AgentStatus.iso.date(from: updatedAt ?? "") }
    var isFresh: Bool {
        guard let d = updatedDate else { return false }
        return Date().timeIntervalSince(d) < 90
    }
    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

// MARK: - disk

enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser
    static let bcc = home.appendingPathComponent(".bcc")
    static let config = bcc.appendingPathComponent("config.json")
    static let uiState = bcc.appendingPathComponent("ui-state.json")
    static let status = bcc.appendingPathComponent("status.json")
    static let log = bcc.appendingPathComponent("agent.log")
    static let ingestToken = bcc.appendingPathComponent(".ingest_secret")
    static let secrets = home.appendingPathComponent(".boston-control-center")
    static let broadcastifyLogin = secrets.appendingPathComponent(".login")
    static let agentBin = URL(fileURLWithPath: "/Library/Application Support/BCC/bin")
    static let plist = URL(fileURLWithPath: "/Library/LaunchAgents/com.bostonglobe.bcc-agent.plist")

    static func ensureDirs() {
        for d in [bcc, secrets] {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
        }
    }
}

enum Disk {
    static func readJSON<T: Decodable>(_ type: T.Type, at url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func writeJSON<T: Encodable>(_ value: T, to url: URL, mode: Int = 0o644) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try enc.encode(value)
        try write(data, to: url, mode: mode)
    }

    // Write to a sibling temp file and rename, so a crash mid write cannot leave
    // the agent reading half a config. The mode is applied before the rename,
    // which is what keeps a secret from existing world readable even briefly.
    static func write(_ data: Data, to url: URL, mode: Int) throws {
        let tmp = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).tmp")
        try data.write(to: tmp, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: tmp.path)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    }

    static func writeSecret(_ text: String, to url: URL) throws {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = clean.data(using: .utf8) else { return }
        try write(data, to: url, mode: 0o600)
    }

    static func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    static func tail(_ url: URL, lines: Int = 400) -> String {
        guard let h = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? h.close() }
        let end = (try? h.seekToEnd()) ?? 0
        let want: UInt64 = 200_000
        let from = end > want ? end - want : 0
        try? h.seek(toOffset: from)
        let data = (try? h.readToEnd()) ?? Data()
        let text = String(data: data, encoding: .utf8) ?? ""
        let all = text.split(separator: "\n", omittingEmptySubsequences: false)
        let slice = all.suffix(lines).joined(separator: "\n")
        return Redact.apply(slice)
    }
}

// The agent embeds Broadcastify credentials in the stream URL it opens, and that
// URL lands in the log. Nothing with a scheme survives to the screen.
enum Redact {
    static func apply(_ s: String) -> String {
        var out = s
        out = out.replacingOccurrences(of: #"https?://[^\s"']+"#,
                                       with: "<url>", options: .regularExpression)
        out = out.replacingOccurrences(of: #"(?i)(api[_-]?key[_a-z]*=)[^\s&"']+"#,
                                       with: "$1<redacted>", options: .regularExpression)
        out = out.replacingOccurrences(of: #"sk-ant-[A-Za-z0-9_\-]+"#,
                                       with: "<key>", options: .regularExpression)
        return out
    }
}
