// ArchiveScreen.swift
//
// Ask the archive the way you would ask a person, hear the answer. The cards
// mirror the dashboard's: what the question was understood to mean, then the
// calls, matched lines marked apart from the context that rode in with them,
// audio on every line and a chain on every card.

import SwiftUI

struct ArchiveScreen: View {
    @State private var q = ""
    @State private var answer: ArchiveAnswer?
    @State private var searching = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section("Ask the archive") {
                    HStack {
                        TextField("big fire last night in Back Bay", text: $q)
                            .focused($focused)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .submitLabel(.search)
                            .onSubmit { Task { await run() } }
                        Button { Task { await run() } } label: {
                            Image(systemName: "magnifyingglass")
                        }.tint(Pal.scanner)
                    }
                    .listRowBackground(Pal.panel)
                    if answer == nil && !searching {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("try").font(.caption2).foregroundStyle(Pal.faint)
                            ForEach(["stabbing last night", "biggest calls tonight", "fires yesterday", "anything at fenway park"], id: \.self) { eg in
                                Button(eg) { q = eg; Task { await run() } }
                                    .font(.caption).tint(Pal.scanner)
                            }
                        }
                        .listRowBackground(Pal.panel)
                    }
                }
                if searching {
                    Section { Text("Searching the archive…").foregroundStyle(Pal.faint).listRowBackground(Pal.panel) }
                }
                if let f = failure {
                    Section { Label(f, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Pal.road).listRowBackground(Pal.panel) }
                }
                if let a = answer {
                    Section {
                        UnderstoodRow(a: a).listRowBackground(Pal.panel)
                    }
                    let results = a.results ?? []
                    if results.isEmpty {
                        Section {
                            Text("Nothing in the archive matches that yet."
                                 + (a.scanned.map { " Read \($0) transmissions from that window." } ?? ""))
                                .font(.callout).foregroundStyle(Pal.dim)
                                .listRowBackground(Pal.panel)
                        }
                    }
                    /* Six above the fold at half the best score, same as the
                       dashboard, so the two never disagree about what leads.
                       Folded by position, not id, so a card without one still
                       lands on exactly one side. */
                    let top = results.first?.score ?? 1
                    let strongIdx = Array(results.indices.filter { (results[$0].score ?? 0) >= top * 0.5 }.prefix(6))
                    let strongSet = Set(strongIdx)
                    let weakIdx = results.indices.filter { !strongSet.contains($0) }
                    ForEach(strongIdx, id: \.self) { i in
                        Section { ArchiveCard(c: results[i]).listRowBackground(Pal.panel) }
                    }
                    if !weakIdx.isEmpty {
                        Section {
                            DisclosureGroup("\(weakIdx.count) weaker matches, probably noise") {
                                ForEach(weakIdx.prefix(20), id: \.self) { i in ArchiveCard(c: results[i]) }
                            }
                            .font(.caption).foregroundStyle(Pal.dim)
                            .listRowBackground(Pal.panel)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Pal.bg)
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private func run() async {
        let query = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        focused = false
        searching = true
        failure = nil
        defer { searching = false }
        do { answer = try await API.search(query) }
        catch { failure = error.localizedDescription; answer = nil }
    }
}

struct UnderstoodRow: View {
    var a: ArchiveAnswer
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                if let w = a.understood?.when { Chip(text: w, color: Pal.dim) }
                if let t = a.understood?.type { Chip(text: t, color: Pal.type(t)) }
                if let p = a.understood?.landmark ?? a.understood?.place { Chip(text: p, color: Pal.transit) }
            }
            Text("\(a.scanned ?? 0) read · \(a.matched ?? 0) matched · \(a.calls ?? 0) calls"
                 + ((a.truncated == true) ? " · window truncated" : ""))
                .font(.caption2).foregroundStyle(Pal.faint)
        }
    }
}

struct ArchiveCard: View {
    var c: ArchiveCall
    @State private var showCtx = false

    private var chain: [String] { (c.clips ?? []).compactMap { $0.u } }
    private var matched: [ArchiveLine] { (c.tx ?? []).filter { $0.ctx != true } }
    private var ctx: [ArchiveLine] { (c.tx ?? []).filter { $0.ctx == true } }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Chip(text: c.type ?? (c.loose == true ? "unmatched" : "call"), color: Pal.type(c.type))
                Text(ETime.clock(c.from) + ((c.to != nil && c.to != c.from) ? "–" + ETime.clock(c.to) : ""))
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(Pal.faint)
                Spacer()
                if !chain.isEmpty { PlayButton(chain: chain, label: "\(c.type ?? "call") · \(c.place ?? "")") }
            }
            if let p = c.place ?? c.town { Text(p).font(.subheadline.weight(.semibold)).lineLimit(2) }
            if let feeds = c.feeds, feeds.count > 1 {
                Text(feeds.joined(separator: " · "))
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.faint)
            }
            ForEach(Array(matched.prefix(6).enumerated()), id: \.offset) { _, l in
                ArchiveLineRow(l: l, dim: false)
            }
            if !ctx.isEmpty {
                Button(showCtx ? "hide context" : "\(ctx.count) lines of scene context") { showCtx.toggle() }
                    .font(.caption2).tint(Pal.dim)
                if showCtx {
                    ForEach(Array(ctx.prefix(20).enumerated()), id: \.offset) { _, l in
                        ArchiveLineRow(l: l, dim: true)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct ArchiveLineRow: View {
    var l: ArchiveLine
    var dim: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            PlayButton(clip: l.clip, label: l.feed ?? "")
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(ETime.clock(l.at)).font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.faint)
                    Text(l.feed ?? "").font(.system(size: 10, design: .monospaced)).foregroundStyle(dim ? Pal.faint : Pal.scanner)
                }
                Text(l.text ?? "").font(.caption).foregroundStyle(dim ? Pal.dim : Pal.ink)
            }
        }
    }
}
