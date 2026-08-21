// BoardScreen.swift
//
// The rail and the wire in one scroll: situations first, the way the desk
// reads them, then the live transcripts underneath, newest first, exactly the
// order the dashboard's console shows. Pull to refresh; it also polls itself
// while it is the screen on top.

import SwiftUI

struct BoardScreen: View {
    @ObservedObject var board = Board.shared
    @State private var picked: Situation?
    @State private var pickedCall: Incident?

    var body: some View {
        NavigationStack {
            List {
                if let p = board.problem {
                    Section {
                        Label(p, systemImage: "wifi.exclamationmark")
                            .font(.caption).foregroundStyle(Pal.road)
                            .listRowBackground(Pal.panel)
                    }
                }
                Section("Situations") {
                    let open = board.situations.filter { $0.isOpen }
                    if open.isEmpty {
                        Text("Desk editor is reading the scanner…")
                            .font(.callout).foregroundStyle(Pal.faint)
                            .listRowBackground(Pal.panel)
                    }
                    ForEach(open, id: \.key) { s in
                        Button { picked = s } label: { SituationRow(s: s) }
                            .buttonStyle(.plain)
                            .listRowBackground(Pal.panel)
                    }
                }
                Section("Active calls") {
                    ForEach(board.scannerActive.prefix(30), id: \.key) { inc in
                        Button { pickedCall = inc } label: { CallRow(inc: inc) }
                            .buttonStyle(.plain)
                            .listRowBackground(Pal.panel)
                    }
                }
                Section("Live wire") {
                    ForEach(board.transcripts.prefix(40), id: \.rowID) { t in
                        WireRow(t: t).listRowBackground(Pal.panel)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Pal.bg)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await board.refresh() }
            .sheet(item: $picked) { s in SituationDetail(s: s).presentationDetents([.medium, .large]).preferredColorScheme(.dark) }
            .sheet(item: $pickedCall) { c in CallDetail(inc: c).presentationDetents([.medium, .large]).preferredColorScheme(.dark) }
        }
        .task { await board.poll() }
    }
}

struct SituationRow: View {
    var s: Situation
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Chip(text: s.type ?? "other", color: Pal.type(s.type))
                if s.isHigh { Chip(text: "high", color: Pal.wire, filled: true) }
                if s.verified == true { Chip(text: "verified", color: Pal.scanner) }
                Spacer()
                Text(ETime.ago(s.updated)).font(.caption2).foregroundStyle(Pal.faint)
            }
            Text(s.headline ?? "").font(.subheadline.weight(.semibold))
            if let sum = s.summary {
                Text(sum).font(.caption).foregroundStyle(Pal.dim).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

struct CallRow: View {
    var inc: Incident
    var body: some View {
        HStack(spacing: 8) {
            IncidentDot(inc: inc)
            VStack(alignment: .leading, spacing: 2) {
                Text(inc.type?.capitalized ?? "Call").font(.subheadline.weight(.semibold))
                Text(inc.location ?? "locating…")
                    .font(.caption).foregroundStyle(inc.location == nil ? Pal.faint : Pal.dim)
                    .lineLimit(1)
            }
            Spacer()
            if let u = inc.units, !u.isEmpty {
                Text(u.prefix(3).joined(separator: " "))
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.faint)
            }
            Text(ETime.ago(inc.lastUpdate)).font(.caption2).foregroundStyle(Pal.faint)
        }
    }
}

struct WireRow: View {
    var t: Transcript
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            PlayButton(clip: t.clip, label: t.source ?? "")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(ETime.clock(t.time, seconds: true))
                        .font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.faint)
                    Text(t.source ?? "").font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.scanner)
                    if let r = t.role, r == "dispatch" || r == "field" {
                        Chip(text: r, color: r == "dispatch" ? Pal.alert : Pal.transit)
                    }
                }
                Text(t.text ?? "").font(.footnote)
            }
        }
    }
}
