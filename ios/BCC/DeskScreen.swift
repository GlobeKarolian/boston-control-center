// DeskScreen.swift
//
// The person at the wall of scanners, in a pocket: the running read on top,
// the ask box under it, and under the answer the exact transmissions it was
// built from, because a sentence a reporter cannot hear is a sentence taken
// on faith and nothing in this system has earned that.

import SwiftUI

struct DeskScreen: View {
    @State private var read: DeskRead?
    @State private var loadingRead = false
    @State private var q = ""
    @State private var answer: DeskAnswer?
    @State private var asking = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section("At the desk · last 20 minutes") {
                    if loadingRead && read == nil {
                        Text("Listening…").foregroundStyle(Pal.faint).listRowBackground(Pal.panel)
                    }
                    if let r = read {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(r.read ?? "No read this time. The transmissions are below.")
                                .font(.callout)
                                .foregroundStyle(r.quiet == true ? Pal.dim : Pal.ink)
                            if let watching = r.watching, !watching.isEmpty {
                                ForEach(Array(watching.enumerated()), id: \.offset) { _, w in
                                    HStack(spacing: 6) {
                                        if (w.severity ?? 0) >= 3 { Chip(text: w.severityLabel ?? "story", color: Pal.sev(w.severity)) }
                                        Text(w.what ?? "").font(.caption)
                                        if let n = w.n, n > 0 {
                                            Text("▸ \(n)").font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.scanner)
                                        }
                                    }
                                }
                            }
                            if let unsure = r.unsure, !unsure.isEmpty {
                                Text("could not make out: " + unsure.joined(separator: " · "))
                                    .font(.caption2.italic()).foregroundStyle(Pal.faint)
                            }
                        }
                        .listRowBackground(Pal.panel)
                    }
                }
                Section("Ask the desk") {
                    HStack {
                        TextField("what were the biggest calls tonight?", text: $q)
                            .focused($focused)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .submitLabel(.send)
                            .onSubmit { Task { await ask() } }
                        Button { Task { await ask() } } label: {
                            Image(systemName: asking ? "hourglass" : "paperplane.fill")
                        }
                        .tint(Pal.scanner)
                        .disabled(asking)
                    }
                    .listRowBackground(Pal.panel)
                    if asking {
                        Text("Reading the radio for that window, this takes a few seconds…")
                            .font(.caption).foregroundStyle(Pal.faint).listRowBackground(Pal.panel)
                    }
                    if let f = failure {
                        Label(f, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Pal.road).listRowBackground(Pal.panel)
                    }
                    if let a = answer {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(a.answer ?? "No answer this time\(a.why.map { ": " + $0 } ?? ""). The transmissions it looked at are below.")
                                .font(.callout)
                            if let clips = a.cited?.clips, !clips.isEmpty {
                                PlayButton(chain: clips, label: "the answer's own audio")
                            } else if a.answer != nil {
                                Text("No transmission could be tied to this answer, so there is nothing to play.")
                                    .font(.caption2.italic()).foregroundStyle(Pal.faint)
                            }
                            Text("answered from \(a.window?.label ?? "the window") · read \(a.shown ?? 0) of \(a.considered ?? 0) transmissions"
                                 + ((a.complete == false) ? " · sampled, not everything" : ""))
                                .font(.caption2).foregroundStyle(Pal.faint)
                        }
                        .listRowBackground(Pal.panel)
                    }
                }
                if let tx = answer?.tx, !tx.isEmpty {
                    Section("What it read") {
                        ForEach(Array(tx.reversed().enumerated()), id: \.offset) { _, l in
                            HStack(alignment: .top, spacing: 6) {
                                PlayButton(clip: l.clip, label: l.feedName)
                                VStack(alignment: .leading, spacing: 1) {
                                    HStack(spacing: 6) {
                                        Text(ETime.clock(l.at)).font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.faint)
                                        Text(l.feedName).font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.scanner)
                                    }
                                    Text(l.text ?? "").font(.caption)
                                }
                            }
                            .listRowBackground(Pal.panel)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Pal.bg)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await loadRead() }
            .task { if read == nil { await loadRead() } }
        }
    }

    private func loadRead() async {
        loadingRead = true
        defer { loadingRead = false }
        do { read = try await API.deskRead(minutes: 20); failure = nil }
        catch { failure = error.localizedDescription }
    }

    private func ask() async {
        let query = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, !asking else { return }
        focused = false
        asking = true
        failure = nil
        defer { asking = false }
        do { answer = try await API.ask(query) }
        catch { failure = error.localizedDescription }
    }
}
