// ShiftScreen.swift
//
// The handoff briefing, phone-first, because "what happened while I was out"
// is the most pocket-shaped question this product answers. Same three parts
// as the web page: things to watch, major calls, also heard. Loads on open
// and on pull; no timer, because a briefing is read, not watched.

import SwiftUI

struct ShiftScreen: View {
    @State private var briefing: ShiftBriefing?
    @State private var loading = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                if let f = failure {
                    Section { Label(f, systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(Pal.road).listRowBackground(Pal.panel) }
                }
                if loading && briefing == nil {
                    Section { Text("Reading the last ten hours of radio…").foregroundStyle(Pal.faint).listRowBackground(Pal.panel) }
                }
                if let b = briefing {
                    if let lead = b.lead {
                        Section {
                            Text(lead).font(.callout).listRowBackground(Pal.panel)
                        } header: {
                            if let w = b.window?.label { Text(w) }
                        }
                    }
                    Section("Things to watch · open right now") {
                        let watch = b.watch ?? []
                        if watch.isEmpty { Text("Nothing open on the board right now.").font(.callout).foregroundStyle(Pal.faint).listRowBackground(Pal.panel) }
                        ForEach(watch) { w in WatchRow(w: w).listRowBackground(Pal.panel) }
                    }
                    Section("Major calls · the stretch behind you") {
                        let major = b.major ?? []
                        if major.isEmpty { Text("Nothing cleared the bar for a write-up.").font(.callout).foregroundStyle(Pal.faint).listRowBackground(Pal.panel) }
                        ForEach(major) { m in MajorRow(m: m).listRowBackground(Pal.panel) }
                    }
                    if let notes = b.notes, !notes.isEmpty {
                        Section("Also heard · more than routine, less than a story") {
                            ForEach(notes) { m in NoteRow(m: m).listRowBackground(Pal.panel) }
                        }
                    }
                    if let cov = b.coverage {
                        Section {
                            Text("\(cov.transmissions ?? 0) transmissions across \(cov.feeds ?? 0) feeds"
                                 + ((b.offline?.isEmpty == false) ? " · \(b.offline!.count) feed(s) offline" : ""))
                                .font(.caption2).foregroundStyle(Pal.faint)
                                .listRowBackground(Pal.panel)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Pal.bg)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await load() }
            .task { if briefing == nil { await load() } }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            briefing = try await API.shift()
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }
}

struct WatchRow: View {
    var w: WatchItem
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Chip(text: w.priority == "high" ? "high priority" : (w.status ?? "active"),
                     color: w.priority == "high" ? Pal.wire : Pal.scanner, filled: w.priority == "high")
                if w.major == true { Chip(text: "major", color: Pal.wire) }
                Spacer()
                Text(ETime.ago(w.updated)).font(.caption2).foregroundStyle(Pal.faint)
            }
            Text(w.headline ?? "").font(.subheadline.weight(.semibold))
            if let what = w.what, !what.isEmpty {
                Text(what).font(.caption).foregroundStyle(Pal.dim).lineLimit(3)
            }
            HStack(spacing: 8) {
                if let clips = w.clips, !clips.isEmpty {
                    PlayButton(chain: clips, label: w.headline ?? "")
                }
                if let feeds = w.feeds, !feeds.isEmpty {
                    Text(feeds.joined(separator: " · ")).font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.faint).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct MajorRow: View {
    var m: ShiftItem
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if m.live == true { LiveChip() }
                Chip(text: (m.severity ?? 0) >= 4 ? "big story" : "story", color: Pal.sev(m.severity), filled: (m.severity ?? 0) >= 4)
                if let k = m.kind, k != "other" { Chip(text: k, color: Pal.type(k)) }
                Spacer()
                Text(ETime.clock(m.from)).font(.caption2).foregroundStyle(Pal.faint)
            }
            Text(m.headline ?? "").font(.subheadline.weight(.semibold))
            if let what = m.what, !what.isEmpty { Text(what).font(.caption).foregroundStyle(Pal.dim) }
            if let unsure = m.unsure, !unsure.isEmpty {
                Text("Confirm before writing: \(unsure)").font(.caption.italic()).foregroundStyle(Pal.road)
            }
            HStack(spacing: 8) {
                if let clips = m.clips, !clips.isEmpty { PlayButton(chain: clips, label: m.headline ?? "") }
                if let n = m.n {
                    Button(open ? "hide \(n) transmissions" : "\(n) transmissions") { open.toggle() }
                        .font(.caption2).tint(Pal.dim)
                }
            }
            if open, let tx = m.tx {
                ForEach(Array(tx.enumerated()), id: \.offset) { _, l in
                    HStack(alignment: .top, spacing: 6) {
                        Text(ETime.clock(l.at)).font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.faint)
                        Text(l.text ?? "").font(.caption2)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct NoteRow: View {
    var m: ShiftItem
    var body: some View {
        HStack(spacing: 8) {
            Text(ETime.clock(m.from)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Pal.faint)
            Text(m.type ?? "call").font(.caption.weight(.semibold))
            Text(m.place ?? "").font(.caption).foregroundStyle(Pal.dim).lineLimit(1)
            Spacer()
            if m.live == true { LiveChip() }
            if let clips = m.clips, !clips.isEmpty { PlayButton(chain: clips, label: m.type ?? "call") }
        }
    }
}
