// AudioPlayer.swift
//
// Hearing the transmission is a founding feature (ROADMAP rule 3), so the
// player is one shared object the whole app talks to, the same way the
// dashboard has one Dial. Play one clip, or a chain oldest-first, from any
// screen; whatever was playing stops, because pressing play IS the newsroom
// saying what it wants to hear next.

import Foundation
import AVFoundation
import Combine
import SwiftUI

@MainActor
final class Radio: ObservableObject {
    static let shared = Radio()

    @Published var nowPlaying: String?      // the clip URL currently sounding
    @Published var queued: Int = 0
    @Published var label: String = ""       // what the chain belongs to

    private var player: AVQueuePlayer?
    private var observer: NSObjectProtocol?

    private init() {
        /* Playback category so a clip keeps sounding with the ringer switch
           off, which is the state every newsroom phone lives in. */
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
    }

    func play(_ url: String, label: String = "") { chain([url], label: label) }

    func chain(_ urls: [String], label: String = "") {
        stop()
        let items = urls.compactMap { URL(string: $0) }.map { AVPlayerItem(url: $0) }
        guard !items.isEmpty else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        let p = AVQueuePlayer(items: items)
        player = p
        self.label = label
        nowPlaying = urls.first
        queued = items.count - 1
        /* Track the head of the queue so the row that is sounding can say so,
           and so the bar disappears when the chain runs out. */
        observer = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main
        ) { [weak self] note in
            guard let self, let p = self.player else { return }
            Task { @MainActor in
                guard let item = note.object as? AVPlayerItem, p.items().contains(item) || item == p.currentItem else { return }
                let remaining = p.items().count - 1
                self.queued = max(0, remaining - 1)
                if remaining <= 0 { self.stop() }
                else if let next = p.items().dropFirst().first?.asset as? AVURLAsset {
                    self.nowPlaying = next.url.absoluteString
                }
            }
        }
        p.play()
    }

    func stop() {
        player?.pause()
        player?.removeAllItems()
        player = nil
        nowPlaying = nil
        queued = 0
        label = ""
        if let o = observer { NotificationCenter.default.removeObserver(o); observer = nil }
    }

    func isPlaying(_ url: String?) -> Bool {
        guard let url, let now = nowPlaying else { return false }
        return url == now
    }
}

/* The bar that appears while something is sounding, above the tab bar on
   every screen, because a control that lives inside one panel of one tab is
   a control nobody can find. */
struct RadioBar: View {
    @ObservedObject var radio = Radio.shared

    var body: some View {
        if radio.nowPlaying != nil {
            HStack(spacing: 10) {
                Image(systemName: "waveform").foregroundStyle(Pal.scanner)
                VStack(alignment: .leading, spacing: 1) {
                    Text(radio.label.isEmpty ? "playing the radio" : radio.label)
                        .font(.footnote.weight(.semibold)).lineLimit(1)
                    if radio.queued > 0 {
                        Text("\(radio.queued) more in the chain")
                            .font(.caption2).foregroundStyle(Pal.dim)
                    }
                }
                Spacer()
                Button { radio.stop() } label: {
                    Image(systemName: "stop.fill").font(.body)
                }
                .tint(Pal.scanner)
                .accessibilityLabel("Stop playback")
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(Pal.panel)
            .overlay(Rectangle().frame(height: 1).foregroundStyle(Pal.border), alignment: .top)
        }
    }
}

/* The play control a row carries. Same glyphs everywhere. */
struct PlayButton: View {
    var clip: String?
    var chain: [String] = []
    var label: String = ""
    @ObservedObject var radio = Radio.shared

    var body: some View {
        let urls = chain.isEmpty ? (clip.map { [$0] } ?? []) : chain
        if urls.isEmpty {
            Text("txt").font(.system(size: 9, design: .monospaced)).foregroundStyle(Pal.faint)
        } else {
            Button {
                if radio.isPlaying(urls.first) { radio.stop() }
                else { radio.chain(urls, label: label) }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: radio.isPlaying(urls.first) ? "stop.fill" : "play.fill")
                        .font(.system(size: 10))
                    if urls.count > 1 { Text("\(urls.count)").font(.system(size: 10, design: .monospaced)) }
                }
                .padding(.horizontal, 7).padding(.vertical, 4)
                .foregroundStyle(Pal.scanner)
                .background(Pal.scanner.opacity(0.13))
                .clipShape(RoundedRectangle(cornerRadius: 5))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(urls.count > 1 ? "Play \(urls.count) transmissions in order" : "Play the transmission")
        }
    }
}
