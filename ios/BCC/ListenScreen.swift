// ListenScreen.swift
//
// The wall of scanners, raw. Every feed the relays carry, one switch each,
// straight off the Broadcastify stream the transcriber itself listens to:
// no transcription, no delay, no judgment in the way. Several at once is the
// point; a newsroom scanner wall was never one radio.
//
// This player is deliberately separate from Radio (the clip player). A clip
// is the room choosing to hear one thing; the wall is ambient. They can
// sound together, exactly as they do in the room.

import SwiftUI
import AVFoundation

@MainActor
final class LiveListen: ObservableObject {
    static let shared = LiveListen()

    @Published var on: Set<String> = []      // rowIDs currently on air
    private var players: [String: AVPlayer] = [:]

    private init() {}

    /* The public stream door for a feed that is a Broadcastify source.
       App-audio and direct-URL relays have no number and no public door. */
    func streamURL(_ f: FeedHealth) -> URL? {
        guard let n = f.feed, n > 0 else { return nil }
        return URL(string: "https://broadcastify.cdnstream1.com/\(n)")
    }

    func canListen(_ f: FeedHealth) -> Bool { streamURL(f) != nil }
    func isOn(_ f: FeedHealth) -> Bool { on.contains(f.rowID) }

    func toggle(_ f: FeedHealth) {
        let key = f.rowID
        if on.contains(key) { stop(key); return }
        guard let u = streamURL(f) else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        /* The referer some stream servers expect from the site's own player. */
        let asset = AVURLAsset(url: u, options: [
            "AVURLAssetHTTPHeaderFieldsKey": ["Referer": "https://www.broadcastify.com/"],
        ])
        let p = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        p.play()
        players[key] = p
        on.insert(key)
    }

    func stop(_ key: String) {
        players[key]?.pause()
        players[key] = nil
        on.remove(key)
    }

    func stopAll() { for k in Array(on) { stop(k) } }
}

struct ListenScreen: View {
    @ObservedObject var board = Board.shared
    @ObservedObject var live = LiveListen.shared

    private var streamable: [FeedHealth] { board.feedList.filter { live.canListen($0) } }
    private var silent: [FeedHealth] { board.feedList.filter { !live.canListen($0) } }

    var body: some View {
        NavigationStack {
            List {
                if board.feedList.isEmpty {
                    Section {
                        Text("No feeds reported yet. Pull to refresh.")
                            .font(.callout).foregroundStyle(Pal.faint)
                            .listRowBackground(Pal.panel)
                    }
                }
                if !live.on.isEmpty {
                    Section {
                        HStack {
                            Image(systemName: "waveform").foregroundStyle(Pal.scanner)
                            Text("\(live.on.count) feed\(live.on.count == 1 ? "" : "s") on the air")
                                .font(.callout.weight(.semibold))
                            Spacer()
                            Button("Stop all") { live.stopAll() }
                                .font(.caption.weight(.bold)).tint(Pal.wire)
                        }
                        .listRowBackground(Pal.panel)
                    }
                }
                Section("The wall · raw, live, unfiltered") {
                    ForEach(streamable, id: \.rowID) { f in
                        FeedListenRow(f: f)
                            .listRowBackground(Pal.panel)
                    }
                }
                if !silent.isEmpty {
                    Section("No public stream") {
                        ForEach(silent, id: \.rowID) { f in
                            HStack(spacing: 8) {
                                FeedDot(status: f.status)
                                Text(f.name).font(.subheadline)
                                Spacer()
                                Text("relay only").font(.caption2).foregroundStyle(Pal.faint)
                            }
                            .listRowBackground(Pal.panel)
                        }
                    }
                }
                Section {
                    Text("These are the live streams the transcriber itself listens to. Nothing here is delayed, transcribed, or checked. It is the air, with the air's language on it.")
                        .font(.caption2).foregroundStyle(Pal.faint)
                        .listRowBackground(Pal.panel)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Pal.bg)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await board.refresh() }
            .task { if board.feedList.isEmpty { await board.refresh() } }
        }
    }
}

struct FeedListenRow: View {
    var f: FeedHealth
    @ObservedObject var live = LiveListen.shared

    var body: some View {
        Button { live.toggle(f) } label: {
            HStack(spacing: 10) {
                FeedDot(status: f.status)
                VStack(alignment: .leading, spacing: 1) {
                    Text(f.name).font(.subheadline.weight(.semibold))
                        .foregroundStyle(Pal.ink)
                    HStack(spacing: 6) {
                        if let n = f.feed {
                            Text("#\(String(n))")
                                .font(.system(size: 10, design: .monospaced)).foregroundStyle(Pal.faint)
                        }
                        Text(f.status ?? "")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(f.isUp ? Pal.scanner : Pal.faint)
                    }
                }
                Spacer()
                if live.isOn(f) {
                    Image(systemName: "waveform")
                        .foregroundStyle(Pal.scanner)
                        .symbolEffect(.variableColor.iterative, options: .repeating)
                }
                Text(live.isOn(f) ? "ON AIR" : "LISTEN")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .tracking(0.5)
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .foregroundStyle(live.isOn(f) ? Pal.bg : Pal.scanner)
                    .background(live.isOn(f) ? Pal.scanner : Pal.scanner.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(live.isOn(f) ? "Stop listening to \(f.name)" : "Listen to \(f.name) live")
    }
}

/* The same four states the backend view names, as a dot. */
struct FeedDot: View {
    var status: String?
    var body: some View {
        let s = status ?? ""
        let c: Color = (s == "live" || s == "connected") ? Pal.scanner
            : (s == "connecting" || s == "reconnecting") ? Pal.road
            : (s == "offline") ? Pal.wire : Pal.faint
        Circle().fill(c).frame(width: 8, height: 8)
    }
}
