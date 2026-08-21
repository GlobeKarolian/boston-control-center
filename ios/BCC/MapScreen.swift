// MapScreen.swift
//
// The map is the product. Incident dots in the board's colours, situations as
// their headline pins, tap for the call with its timeline and its audio. The
// venue treatment carries over from the dashboard: a call off a building's own
// radio (Fenway Park) draws squared rather than round, because its pin is the
// building's and not the call's.

import SwiftUI
import MapKit

struct MapScreen: View {
    @ObservedObject var board = Board.shared
    @State private var camera: MapCameraPosition = .region(
        MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 42.3401, longitude: -71.0689),
                           span: MKCoordinateSpan(latitudeDelta: 0.28, longitudeDelta: 0.28)))
    @State private var picked: Incident?
    @State private var pickedSit: Situation?
    @State private var showCleared = false

    private var pins: [Incident] {
        board.incidents.filter { inc in
            guard inc.lat != nil, inc.lon != nil else { return false }
            /* No centroid dogpile: a call the geocoder could only place at
               the town's middle draws nowhere. It is still on the Board. */
            if inc.precision == "weak" || inc.precision == "wide" { return false }
            return showCleared || inc.isActive
        }
    }
    private var sitPins: [Situation] {
        board.situations.filter { $0.lat != nil && $0.lon != nil && $0.isOpen }
    }

    var body: some View {
        Map(position: $camera) {
            ForEach(sitPins, id: \.key) { s in
                Annotation(s.headline ?? "", coordinate: CLLocationCoordinate2D(latitude: s.lat ?? 0, longitude: s.lon ?? 0)) {
                    Circle()
                        .fill(Pal.alert.opacity(0.25))
                        .stroke(Pal.alert, lineWidth: 1.5)
                        .frame(width: s.isHigh ? 34 : 24, height: s.isHigh ? 34 : 24)
                        .onTapGesture { pickedSit = s }
                        .accessibilityLabel(s.headline ?? "situation")
                }
                .annotationTitles(.hidden)
            }
            ForEach(pins, id: \.key) { inc in
                Annotation(inc.type ?? "call", coordinate: CLLocationCoordinate2D(latitude: inc.lat ?? 0, longitude: inc.lon ?? 0)) {
                    IncidentDot(inc: inc)
                        .onTapGesture { picked = inc }
                        .accessibilityLabel("\(inc.type ?? "call") at \(inc.location ?? "")")
                }
                .annotationTitles(.hidden)
            }
        }
        /* Muted, flat, nothing Apple wants to sell: the closest MapKit gets
           to the wall's dimmed vector base. Dark tiles come with the app's
           dark scheme. */
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
        .overlay(alignment: .topLeading) {
            /* A failure has to say what failed, on screen, or it can never
               be fixed from a screenshot. */
            if let p = board.problem {
                Text(p)
                    .font(.caption2).foregroundStyle(Pal.wire)
                    .lineLimit(3)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Pal.panel.opacity(0.92))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .frame(maxWidth: 340, alignment: .leading)
                    .padding(10)
            }
        }
        .overlay(alignment: .bottom) {
            /* The strip the wall keeps in its header: what is active, what is
               up, in the board's own mono. It also holds the one map control. */
            HStack(spacing: 10) {
                HStack(spacing: 5) {
                    Circle().fill(Pal.scanner).frame(width: 6, height: 6)
                    Text("\(board.scannerActive.count) ACTIVE")
                }
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(Pal.scanner)
                if !sitPins.isEmpty {
                    Text("\(sitPins.count) SITUATION\(sitPins.count == 1 ? "" : "S")")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(Pal.alert)
                }
                if board.feedsOffline > 0 {
                    Text("\(board.feedsOffline) FEED\(board.feedsOffline == 1 ? "" : "S") DOWN")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(Pal.road)
                }
                Spacer()
                Button { showCleared.toggle() } label: {
                    Text(showCleared ? "HIDE CLEARED" : "SHOW CLEARED")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .tracking(0.5)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .foregroundStyle(showCleared ? Pal.bg : Pal.dim)
                        .background(showCleared ? Pal.dim : Pal.dim.opacity(0.16))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Pal.bg.opacity(0.92))
            .overlay(Rectangle().frame(height: 1).foregroundStyle(Pal.border), alignment: .top)
        }
        .sheet(item: $picked) { inc in
            CallDetail(inc: inc).presentationDetents([.medium, .large]).preferredColorScheme(.dark)
        }
        .sheet(item: $pickedSit) { s in
            SituationDetail(s: s).presentationDetents([.medium, .large]).preferredColorScheme(.dark)
        }
        .task { await board.poll() }
    }
}

struct IncidentDot: View {
    var inc: Incident
    var body: some View {
        let c = Pal.type(inc.type)
        let side: CGFloat = inc.isHigh ? 16 : 12
        /* Squared for a venue call, round for one the geocoder placed: the
           same distinction the dashboard draws, for the same reason. */
        RoundedRectangle(cornerRadius: inc.venue != nil ? 3 : side)
            .fill(inc.isActive ? c : Pal.faint)
            .frame(width: side, height: side)
            .overlay(RoundedRectangle(cornerRadius: inc.venue != nil ? 3 : side)
                .stroke(Pal.bg, lineWidth: 1.5))
            .shadow(color: inc.isActive ? c.opacity(0.7) : .clear, radius: 4)
            .opacity(inc.isActive ? 1 : 0.65)
    }
}

struct CallDetail: View {
    var inc: Incident
    private var chain: [String] { (inc.timeline ?? []).compactMap { $0.clip } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(inc.type?.capitalized ?? "Call").font(.title3.bold())
                        if let l = inc.location { Text(l).foregroundStyle(Pal.dim) }
                        if let v = inc.venue {
                            Text("\(v) radio · pin is the building, not the call")
                                .font(.caption.italic()).foregroundStyle(Pal.faint)
                        }
                        HStack(spacing: 6) {
                            Chip(text: inc.isActive ? "active" : (inc.status ?? "cleared"),
                                 color: inc.isActive ? Pal.scanner : Pal.faint, filled: inc.isActive)
                            if inc.isHigh { Chip(text: "priority", color: Pal.wire, filled: true) }
                            if let u = inc.units, !u.isEmpty {
                                Text(u.joined(separator: ", "))
                                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(Pal.dim)
                            }
                        }
                        if !chain.isEmpty {
                            PlayButton(chain: chain, label: "\(inc.type ?? "call") · \(inc.location ?? "")")
                        }
                        Unverified()
                    }
                    .listRowBackground(Pal.panel)
                }
                Section("Transmissions") {
                    ForEach(Array((inc.timeline ?? []).reversed().enumerated()), id: \.offset) { _, b in
                        HStack(alignment: .top, spacing: 8) {
                            PlayButton(clip: b.clip, label: inc.type ?? "call")
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(ETime.clock(b.t, seconds: true))
                                        .font(.system(size: 11, design: .monospaced)).foregroundStyle(Pal.faint)
                                    if let r = b.role, r == "dispatch" || r == "field" {
                                        Chip(text: r, color: r == "dispatch" ? Pal.alert : Pal.transit)
                                    }
                                }
                                Text(b.text ?? "").font(.callout)
                            }
                        }
                        .listRowBackground(Pal.panel)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Pal.bg)
            .navigationTitle(inc.location ?? "Call")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct SituationDetail: View {
    var s: Situation
    private var chain: [String] { (s.events ?? []).flatMap { $0.clips ?? [] } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(s.headline ?? "").font(.title3.bold())
                        if let sum = s.summary { Text(sum).foregroundStyle(Pal.dim) }
                        HStack(spacing: 6) {
                            if s.isHigh { Chip(text: "high priority", color: Pal.wire, filled: true) }
                            if s.major == true { Chip(text: "major", color: Pal.wire) }
                            if s.verified == true { Chip(text: "verified", color: Pal.scanner) }
                            if let lbl = s.severityLabel { Chip(text: lbl, color: Pal.sev(s.severity)) }
                        }
                        if let loc = s.location { Text(loc).font(.caption).foregroundStyle(Pal.faint) }
                        if !chain.isEmpty { PlayButton(chain: chain, label: s.headline ?? "situation") }
                        Unverified()
                    }
                    .listRowBackground(Pal.panel)
                }
                Section("The thread") {
                    ForEach(Array((s.events ?? []).reversed().enumerated()), id: \.offset) { _, e in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(ETime.clock(e.at)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Pal.faint)
                                if let k = e.kind, k != "update" { Chip(text: k, color: Pal.dim) }
                                if let c = e.clips, !c.isEmpty { PlayButton(chain: c, label: s.headline ?? "") }
                            }
                            Text(e.text ?? "").font(.callout)
                        }
                        .listRowBackground(Pal.panel)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Pal.bg)
            .navigationTitle("Situation")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
