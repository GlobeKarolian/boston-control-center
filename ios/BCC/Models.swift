// Models.swift
//
// The wire shapes, exactly as web/lib writes them and no stricter.
//
// Every field is optional on purpose. The server side of this product ships
// several times a day and adds fields without ceremony; a native app that
// throws on an unknown or missing key is an app that breaks on somebody
// else's Tuesday. Decoding failures here should be impossible by
// construction: worst case a card renders with less on it.

import Foundation

/* An element that refuses to decode drops out instead of sinking the whole
   array. incidents.json carries news-feed items alongside scanner calls, and
   the server adds fields without ceremony; one odd row must never blank the
   board. */
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) { value = try? T(from: decoder) }
}

// MARK: - Board

struct Incident: Codable, Identifiable, Hashable {
    var id: String?
    var type: String?
    var title: String?
    var location: String?
    var lat: Double?
    var lon: Double?
    var status: String?
    var priority: String?
    var feed: String?
    var town: String?
    var units: [String]?
    var firstHeard: String?
    var lastUpdate: String?
    var tier: Double?
    var tierName: String?
    var heat: Double?
    var alarm: Double?
    var why: [String]?
    var timeline: [Beat]?
    var timelineTotal: Int?
    /* The building this call is inside, for a venue feed (lib/venues.js):
       the pin is the building's, and the section or gate rides in detail. */
    var venue: String?
    var detail: String?
    /* How the geocoder earned the pin. 'weak' is the town centroid: a fake
       place thousands of calls a day share. The map draws exact/approx only,
       the same whitelist the server's scene grouper uses. */
    var precision: String?

    var isActive: Bool { (status ?? "") == "active" }
    var isHigh: Bool { (priority ?? "") == "high" }
    /* A row key that exists even when the wire id does not. */
    var key: String { id ?? "\(firstHeard ?? "")|\(location ?? "")|\(type ?? "")" }
}

struct Beat: Codable, Hashable {
    var t: String?
    var source: String?
    var text: String?
    var role: String?
    var clip: String?
    var onScene: Bool?
    var clear: Bool?
}

struct Situation: Codable, Identifiable, Hashable {
    var id: String?
    var headline: String?
    var summary: String?
    var type: String?
    var priority: String?
    var confidence: String?
    var location: String?
    var lat: Double?
    var lon: Double?
    var status: String?
    var feeds: [String]?
    var firstSeen: String?
    var updated: String?
    var severity: Double?
    var severityLabel: String?
    var major: Bool?
    var verified: Bool?
    var events: [SitEvent]?

    var isOpen: Bool { (status ?? "") != "closed" }
    var isHigh: Bool { (priority ?? "") == "high" }
    var key: String { id ?? "\(firstSeen ?? "")|\(headline ?? "")" }
}

struct SitEvent: Codable, Hashable {
    var kind: String?
    var text: String?
    var type: String?
    var at: String?
    var clips: [String]?
}

struct Transcript: Codable, Identifiable, Hashable {
    var id: String?
    var source: String?
    var text: String?
    var time: String?
    var incidentId: String?
    var role: String?
    var clip: String?

    /* The wire id is unique within a store generation; a missing one still
       has to key a SwiftUI row. */
    var rowID: String { id ?? "\(time ?? "")|\(source ?? "")|\(text?.prefix(40) ?? "")" }
}
extension Transcript { var idOrRow: String { rowID } }

// MARK: - Shift Change

struct ShiftBriefing: Codable {
    var ok: Bool?
    var lead: String?
    var window: ShiftWindow?
    var watch: [WatchItem]?
    var major: [ShiftItem]?
    var notes: [ShiftItem]?
    var offline: [String]?
    var coverage: Coverage?
    var generatedAt: String?
    var why: String?
}

struct ShiftWindow: Codable {
    var from: String?
    var to: String?
    var label: String?
    var hours: Double?
}

struct Coverage: Codable {
    var transmissions: Int?
    var feeds: Int?
    var complete: Bool?
    var sampled: Bool?
}

struct WatchItem: Codable, Identifiable {
    var id: String?
    var kind: String?
    var headline: String?
    var what: String?
    var status: String?
    var priority: String?
    var major: Bool?
    var verified: Bool?
    var severity: Double?
    var label: String?
    var type: String?
    var place: String?
    var feeds: [String]?
    var units: [String]?
    var since: String?
    var updated: String?
    var n: Int?
    var why: [String]?
    var clips: [String]?
    var tx: [ShiftLine]?
}

struct ShiftItem: Codable, Identifiable {
    var id: String?
    var headline: String?
    var what: String?
    var unsure: String?
    var severity: Double?
    var label: String?
    var why: [String]?
    var kind: String?
    var live: Bool?
    var feeds: [String]?
    var units: [String]?
    var from: String?
    var to: String?
    var place: String?
    var type: String?
    var n: Int?
    var clips: [String]?
    var tx: [ShiftLine]?
}

struct ShiftLine: Codable, Hashable {
    var at: String?
    var src: String?
    var source: String?
    var feed: String?
    var text: String?
    var clip: String?
    var where_: String?

    enum CodingKeys: String, CodingKey {
        case at, src, source, feed, text, clip
        case where_ = "where"
    }
    var feedName: String { src ?? source ?? feed ?? "" }
}

// MARK: - Archive search

struct ArchiveAnswer: Codable {
    var ok: Bool?
    var why: String?
    var q: String?
    var understood: Understood?
    var scanned: Int?
    var matched: Int?
    var calls: Int?
    var truncated: Bool?
    var results: [ArchiveCall]?
    var coverage: ArchiveCoverage?
    var ms: Int?
}

struct Understood: Codable {
    var when: String?
    var from: String?
    var to: String?
    var type: String?
    var place: String?
    var landmark: String?
    var big: Bool?
    var words: [String]?
    var phrases: [String]?
}

struct ArchiveCoverage: Codable {
    var from: String?
    var to: String?
}

struct ArchiveCall: Codable, Identifiable {
    var id: String?
    var loose: Bool?
    var feed: String?
    var feeds: [String]?
    var town: String?
    var type: String?
    var place: String?
    var from: String?
    var to: String?
    var score: Double?
    var units: [String]?
    var tx: [ArchiveLine]?
    var clips: [ArchiveClip]?
}

struct ArchiveLine: Codable, Hashable {
    var at: String?
    var feed: String?
    var text: String?
    var clip: String?
    /* Context arrived because it was linked to the anchor, not because it
       matched what was typed; the card says which lines earned their place. */
    var ctx: Bool?
}

struct ArchiveClip: Codable, Hashable {
    var u: String?
    var at: String?
}

// MARK: - The desk

struct DeskRead: Codable {
    var ok: Bool?
    var why: String?
    var read: String?
    var quiet: Bool?
    var watching: [DeskWatch]?
    var unsure: [String]?
    var heard: [String: Int]?
    var complete: Bool?
    var tx: [ShiftLine]?
    var ms: Int?
}

struct DeskWatch: Codable, Hashable {
    var what: String?
    var n: Int?
    var severity: Double?
    var severityLabel: String?
    var why: [String]?
}

struct DeskAnswer: Codable {
    var ok: Bool?
    var why: String?
    var q: String?
    var answer: String?
    var cited: Cited?
    var window: AskWindow?
    var considered: Int?
    var shown: Int?
    var matched: Int?
    var complete: Bool?
    var sampled: Bool?
    var tx: [ShiftLine]?
    var ms: Int?
}

struct Cited: Codable {
    var at: [String]?
    var clips: [String]?
    var n: Int?
}

struct AskWindow: Codable {
    var from: String?
    var to: String?
    var named: Bool?
    var label: String?
}

// MARK: - Pipeline health (the status pill)

struct Pipeline: Codable {
    var generatedAt: String?
    var feeds: [FeedHealth]?
}

struct FeedHealth: Codable, Identifiable {
    var id: String?
    var label: String?
    var status: String?
    var machine: String?
    /* The Broadcastify feed number, when the source is one: the door to the
       raw stream. Null for app-audio and direct-URL sources. */
    var feed: Int?
    var src: String?

    /* id can repeat across machines; a row still needs one stable key. */
    var rowID: String { "\(machine ?? "")|\(id ?? label ?? "feed")" }
    var name: String { label ?? src ?? id ?? "feed" }
    var isUp: Bool { status == "live" || status == "connected" }
}

// MARK: - Time, the way the board says it

enum ETime {
    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static func date(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return iso.date(from: s) ?? isoPlain.date(from: s)
    }
    /* Eastern on every clock, because that is the newsroom's wall clock and
       what every transcript stamp means. A phone on assignment in another
       time zone must not shift the radio. */
    static let eastern = TimeZone(identifier: "America/New_York")!
    static func clock(_ s: String?, seconds: Bool = false) -> String {
        guard let d = date(s) else { return "" }
        let f = DateFormatter()
        f.timeZone = eastern
        f.dateFormat = seconds ? "h:mm:ss a" : "h:mm a"
        return f.string(from: d)
    }
    /* The masthead clock: Eastern, always, whatever zone the phone is in. */
    static func clockNow(_ d: Date) -> String {
        let f = DateFormatter()
        f.timeZone = eastern
        f.dateFormat = "h:mm:ss a"
        return f.string(from: d)
    }
    static func ago(_ s: String?) -> String {
        guard let d = date(s) else { return "" }
        let m = Int(Date().timeIntervalSince(d) / 60)
        if m < 1 { return "just now" }
        if m < 60 { return "\(m)m ago" }
        let h = m / 60
        if h < 36 { return "\(h)h \(m % 60)m ago" }
        return "\(h / 24)d ago"
    }
}
