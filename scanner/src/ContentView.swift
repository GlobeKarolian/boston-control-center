import SwiftUI

struct ContentView: View {
    @ObservedObject var ctl: Controller
    @ObservedObject var store: Store
    @StateObject private var downloads = ModelDownloads()
    @State private var showSettings = false
    @State private var now = Date()

    private let clock = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    feedsSection
                    if store.running || store.load.measured { loadSection }
                    settingsSection
                }
                .padding(16)
            }
            Divider()
            logPane
        }
        .frame(minWidth: 780, minHeight: 720)
        .onReceive(clock) { now = $0 }
        .onChange(of: store.sources) { _, _ in store.save() }
    }

    /* --------------------------------------------------------------- top --- */

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Scanner Relay").font(.system(size: 17, weight: .semibold))
                Text("\(store.machine)  →  \(hostLabel)")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer()
            relayChip
            Button(store.running ? "Stop Capture" : "Start Capture") { ctl.toggle() }
                .keyboardShortcut(.return, modifiers: [.command])
                .controlSize(.large)
                .buttonStyle(.borderedProminent)
                .tint(store.running ? .red : .accentColor)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var hostLabel: String {
        URL(string: store.endpoint)?.host ?? "no dashboard set"
    }

    private var relayChip: some View {
        let (color, text): (Color, String) = {
            switch store.relayState {
            case "ok":             return (.green,  "sending")
            case "queued":         return (.yellow, "\(store.queued) queued")
            case "offline":        return (.orange, "dashboard unreachable")
            case "token rejected": return (.red,    "token rejected")
            default:               return (.secondary, "idle")
            }
        }()
        return HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text).font(.system(size: 12))
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Color.primary.opacity(0.06), in: Capsule())
    }

    /* ------------------------------------------------------------- feeds --- */

    private var feedsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("FEEDS").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary).tracking(0.6)
                Spacer()
                Button { store.addSource() } label: { Label("Add Feed", systemImage: "plus") }
                    .buttonStyle(.borderless)
            }

            if store.sources.isEmpty {
                emptyState
            } else {
                ForEach($store.sources) { $s in
                    FeedRow(source: $s, store: store, status: store.status(s), now: now,
                            running: store.running,
                            onDelete: { store.remove(s) })
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No feeds yet.").font(.system(size: 13, weight: .medium))
            Text("Press Add Feed, paste a Broadcastify link, and give it a name. "
                 + "A feed number on its own works too.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    /* -------------------------------------------------------------- load --- */

    /* Processor percentage would be the wrong number to show. Whisper decodes
       one clip at a time, so what matters is the share of the clock it is busy,
       and how close that is to the point where clips start stacking up behind
       each other. */
    private var loadSection: some View {
        let L = store.load
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("SYSTEM LOAD").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary).tracking(0.6)
                Spacer()
                if L.clips > 0 {
                    Text("\(L.clips) clip\(L.clips == 1 ? "" : "s") in the last two minutes")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(Int((L.duty * 100).rounded()))%")
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                        .foregroundStyle(dutyColor(L))
                    Text("of the clock spent turning radio into text")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.primary.opacity(0.08))
                        Capsule().fill(dutyColor(L))
                            .frame(width: max(3, geo.size.width * min(1, max(0, L.duty))))
                        /* The mark sits at eighty percent, the point past which
                           one busy minute of radio costs minutes of delay. */
                        Rectangle().fill(Color.primary.opacity(0.45))
                            .frame(width: 1.5)
                            .offset(x: geo.size.width * 0.80)
                    }
                }
                .frame(height: 9)

                Text(L.verdict)
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)

                HStack(alignment: .top, spacing: 0) {
                    stat("feeds", L.burstCeiling > 0 ? "\(L.feeds) of \(L.burstCeiling)" : "\(L.feeds)")
                    stat("speed", L.speed > 0 ? String(format: "%.1fx", L.speed) : "n/a")
                    stat("waiting", "\(L.queueDepth)")
                    stat("cpu load", String(format: "%.2f", L.loadAverage))
                    stat("thermal", L.thermal)
                    stat("model", "\(L.modelMB) MB")
                }
                Text("Speed is seconds of audio handled per second of work, so it sets how many "
                     + "feeds could be talking at the same moment. That is the second number "
                     + "under feeds. Under one means this Mac cannot keep up with even one busy feed.")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(14)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary).tracking(0.5)
            Text(value).font(.system(size: 12, design: .monospaced))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func dutyColor(_ l: LoadReading) -> Color {
        switch l.tone {
        case 2:  return .red
        case 1:  return .orange
        default: return .green
        }
    }

    /* ---------------------------------------------------------- settings --- */

    private var settingsSection: some View {
        DisclosureGroup(isExpanded: $showSettings) {
            VStack(alignment: .leading, spacing: 12) {
                field("Dashboard URL", text: $store.endpoint,
                      hint: "where transcripts are sent")
                secureField("Ingest token", text: $store.ingestToken,
                            hint: "this machine's key, from the dashboard")

                HStack(spacing: 10) {
                    Button("Test Connection") { ctl.testConnection() }
                    if let r = ctl.testResult {
                        Label(r, systemImage: ctl.testOK ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(ctl.testOK ? Color.green : Color.red)
                    }
                }

                Divider().padding(.vertical, 2)

                modelSection

                Divider().padding(.vertical, 2)

                extractionSection

                Divider().padding(.vertical, 2)

                Text("Broadcastify Premium").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary).tracking(0.6)
                Text("Only needed for broadcastify.com feeds. Other stream URLs play without it.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                field("Username", text: $store.bfUser, hint: "")
                secureField("Password", text: $store.bfPass, hint: "")

                Divider().padding(.vertical, 2)

                field("Machine name", text: $store.machine,
                      hint: "how this Mac is labelled on the dashboard")

                HStack(spacing: 18) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Segment length").font(.system(size: 11)).foregroundStyle(.secondary)
                        Stepper("\(Int(store.segmentSeconds)) seconds",
                                value: $store.segmentSeconds, in: 5 ... 60, step: 5)
                            .frame(width: 180)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Silence gate").font(.system(size: 11)).foregroundStyle(.secondary)
                        Text(String(format: "%.3f", store.silenceGate))
                            .font(.system(size: 12, design: .monospaced))
                        Slider(value: $store.silenceGate, in: 0 ... 0.05).frame(width: 180)
                    }
                }
                .onChange(of: store.segmentSeconds) { _, _ in store.save() }
                .onChange(of: store.silenceGate) { _, _ in store.save() }
            }
            .padding(.top, 10)
            .onChange(of: store.endpoint) { _, _ in store.save() }
            .onChange(of: store.machine) { _, _ in store.save() }
        } label: {
            Text("SETTINGS").font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary).tracking(0.6)
        }
    }

    /* ------------------------------------------------------------- model --- */

    private var modelSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SPEECH MODEL").font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary).tracking(0.6)
            Text("A bigger model reads clipped and noisy radio better and costs more time "
                 + "per clip. Watch the load readout after you switch. A change takes effect "
                 + "the next time capture starts.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(SpeechModel.all) { m in modelRow(m) }
        }
    }

    private func modelRow(_ m: SpeechModel) -> some View {
        let chosen = store.modelID == m.id
        let have = downloads.ready.contains(m.id)
        let working = downloads.progress[m.id]

        return HStack(alignment: .top, spacing: 10) {
            Button {
                store.modelID = m.id
                store.save()
                store.note("speech model set to \(m.label)")
            } label: {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen ? Color.accentColor : Color.secondary)
            }
            .buttonStyle(.borderless)
            .disabled(!have)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(m.label).font(.system(size: 12, weight: .medium))
                    Text("\(m.megabytes) MB").font(.system(size: 11)).foregroundStyle(.secondary)
                    if m.id == SpeechModel.bundledID {
                        Text("included").font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.primary.opacity(0.08), in: Capsule())
                    }
                }
                Text(m.note).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let f = working {
                    ProgressView(value: f).frame(width: 240)
                }
                if let e = downloads.failure[m.id], !e.isEmpty {
                    Text(e).font(.system(size: 11)).foregroundStyle(.red)
                }
            }

            Spacer()

            if working != nil {
                Button("Cancel") { downloads.cancel(m) }.buttonStyle(.borderless)
            } else if !have {
                Button("Download") { downloads.start(m) { line in store.note(line) } }
            } else if ModelStore.downloaded(m) != nil {
                Button("Remove") {
                    if store.modelID == m.id {
                        store.modelID = SpeechModel.bundledID
                        store.save()
                    }
                    downloads.delete(m) { line in store.note(line) }
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 3)
    }

    /* -------------------------------------------------------- extraction --- */

    /* Where the reading happens. The cloud spends the dashboard's model
       budget, which ran the account dry once already; this Mac spends
       electricity. Same row grammar as the speech models above, because to
       the person at this window they are the same kind of decision. */
    private var extractionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("EXTRACTION MODEL").font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary).tracking(0.6)
            Text("Every transmission is read into units, addresses and severity. "
                 + "The cloud does this against a paid daily budget; a model on this Mac "
                 + "does it for free, next to Whisper. The dashboard checks either way, "
                 + "and a transmission the local model fumbles just falls back to the cloud ladder.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            cloudRow
            ForEach(LocalModel.all) { m in localRow(m) }

            if store.extractMode == "local" {
                if ctl.ollama.reachable == false {
                    Text("Ollama is not running on this Mac. Open the Ollama app, or install it from ollama.com, then start capture again.")
                        .font(.system(size: 11)).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let v = ctl.ollama.contractVersion {
                    Text("contract v\(v) · judgment stays on the dashboard")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
        }
        .onAppear { ctl.ollama.refresh() }
    }

    private var cloudRow: some View {
        HStack(alignment: .top, spacing: 10) {
            Button {
                store.extractMode = "cloud"; store.save()
                store.note("extraction set to cloud")
            } label: {
                Image(systemName: store.extractMode == "cloud" ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(store.extractMode == "cloud" ? Color.accentColor : Color.secondary)
            }
            .buttonStyle(.borderless)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text("Cloud, Claude Haiku").font(.system(size: 12, weight: .medium))
                    Text("default").font(.system(size: 9, weight: .semibold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.primary.opacity(0.08), in: Capsule())
                }
                Text("The dashboard reads every transmission against its daily budget, "
                     + "500 calls, then regex. Nothing to install.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(.vertical, 3)
    }

    private func localRow(_ m: LocalModel) -> some View {
        let chosen = store.extractMode == "local" && store.extractModel == m.id
        let have = ctl.ollama.installed.contains(m.id)
        let working = ctl.ollama.progress[m.id]

        return HStack(alignment: .top, spacing: 10) {
            Button {
                store.extractMode = "local"; store.extractModel = m.id; store.save()
                store.note("extraction set to \(m.label) on this Mac; takes effect when capture starts")
                ctl.ollama.refresh()
            } label: {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen ? Color.accentColor : Color.secondary)
            }
            .buttonStyle(.borderless)
            .disabled(!have)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(m.label).font(.system(size: 12, weight: .medium))
                    Text(String(format: "%.1f GB", m.gigabytes)).font(.system(size: 11)).foregroundStyle(.secondary)
                    if m.id == LocalModel.recommendedID {
                        Text("recommended").font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.primary.opacity(0.08), in: Capsule())
                    }
                }
                Text(m.note).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let f = working {
                    ProgressView(value: f).frame(width: 240)
                }
                if let e = ctl.ollama.failure[m.id], !e.isEmpty {
                    Text(e).font(.system(size: 11)).foregroundStyle(.red)
                }
            }

            Spacer()

            if working != nil {
                Button("Cancel") { ctl.ollama.cancel(m) }.buttonStyle(.borderless)
            } else if !have {
                Button("Download") { ctl.ollama.pull(m) { line in store.note(line) } }
                    .disabled(ctl.ollama.reachable == false)
            }
        }
        .padding(.vertical, 3)
    }

    private func field(_ title: String, text: Binding<String>, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary)
            TextField(hint, text: text).textFieldStyle(.roundedBorder)
        }
    }

    private func secureField(_ title: String, text: Binding<String>, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary)
            SecureField(hint, text: text).textFieldStyle(.roundedBorder)
        }
    }

    /* --------------------------------------------------------------- log --- */

    private var logPane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(store.log.enumerated()), id: \.offset) { i, line in
                        Text(line)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(i)
                    }
                }
                .padding(10)
            }
            .frame(height: 150)
            .background(Color.primary.opacity(0.03))
            .onChange(of: store.log.count) { _, c in
                if c > 0 { withAnimation { proxy.scrollTo(c - 1, anchor: .bottom) } }
            }
        }
    }
}

/* ------------------------------------------------------------- feed row --- */

struct FeedRow: View {
    @Binding var source: Source
    @ObservedObject var store: Store
    let status: SourceStatus
    let now: Date
    let running: Bool
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Toggle("", isOn: $source.enabled).labelsHidden()
                TextField("Name, for example Boston Fire", text: $source.label)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 170)

                Picker("", selection: $source.kind) {
                    Text("Stream").tag("stream")
                    Text("App audio").tag("app")
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(width: 108)

                if source.isAppAudio {
                    appPicker
                } else {
                    TextField("Paste a Broadcastify link, or a feed number", text: $source.url)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { normalize() }
                }

                Button(role: .destructive) { onDelete() } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }

            /* Every town in Massachusetts has a Main St, so a street name off
               the radio is worthless without knowing which towns the feed
               reaches. One town for a city feed, a list for a regional one. */
            HStack(spacing: 8) {
                Text("Covers").font(.system(size: 11)).foregroundStyle(.secondary)
                TextField("Boston", text: $source.city)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 130)
                TextField("Other towns this feed reaches, separated by commas. Leave blank for just the one.",
                          text: $source.scope)
                    .textFieldStyle(.roundedBorder)
            }

            if source.isAppAudio {
                Text("Play the feed in that application and leave it playing. macOS asks once "
                     + "for screen recording permission, which is what lets one application's "
                     + "sound be read. Nothing is recorded to disk and no picture is captured.")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 7) {
                Circle().fill(dotColor).frame(width: 7, height: 7)
                Text(statusLine).font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
            }

            if let e = status.lastError, !e.isEmpty {
                Text(e).font(.system(size: 11)).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !status.lastText.isEmpty {
                Text(status.lastText)
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(2)
                    .foregroundStyle(.primary.opacity(0.75))
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    /* Boston Police is not on Broadcastify, so the way in is to let Chrome play
       the department's own web player and take the sound back out of the Mac.
       Browsers sort to the top because that is what this is for. */
    private var appPicker: some View {
        HStack(spacing: 6) {
            Picker("", selection: $source.bundleID) {
                Text("Pick an application").tag("")
                ForEach(orderedApps) { a in Text(a.name).tag(a.id) }
                /* A choice made yesterday should survive an application that
                   happens to be closed right now. */
                if !source.bundleID.isEmpty,
                   !store.audioApps.contains(where: { $0.id == source.bundleID }) {
                    Text(source.bundleID).tag(source.bundleID)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Button { store.refreshAudioApps() } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("List the applications this Mac can hear")
        }
        .onAppear { if store.audioApps.isEmpty { store.refreshAudioApps() } }
    }

    private var orderedApps: [AudioApp] {
        let first = store.audioApps.filter { SystemAudio.preferred.contains($0.id) }
        let rest = store.audioApps.filter { !SystemAudio.preferred.contains($0.id) }
        return first + rest
    }

    private func normalize() {
        source.url = Source.normalize(source.url)
        if source.label.isEmpty,
           let m = source.url.range(of: "[0-9]+(?=\\.mp3)", options: .regularExpression) {
            source.label = "Feed \(source.url[m])"
        }
    }

    /* Grey when nothing is running, so a stopped app never shows a green light.
       That distinction is the whole point of the dot. */
    private var dotColor: Color {
        if !source.enabled { return .secondary.opacity(0.4) }
        if !running { return .secondary.opacity(0.4) }
        if status.lastError != nil && status.state == "error" { return .red }
        switch status.state {
        case "live":       return status.clips > 0 ? .green : .yellow
        case "connecting": return .orange
        case "error":      return .red
        default:           return .secondary.opacity(0.4)
        }
    }

    private var statusLine: String {
        if !source.enabled { return "off" }
        if !running { return "not capturing" }
        var bits: [String] = []
        switch status.state {
        case "live":       bits.append(status.clips > 0 ? "live" : "listening")
        case "connecting": bits.append("connecting")
        case "error":      bits.append("error")
        default:           bits.append(status.state)
        }
        if status.segments > 0 { bits.append("\(status.segments) segments") }
        if status.clips > 0 { bits.append("\(status.clips) transcripts") }
        if let t = status.lastTextAt { bits.append("last text \(ago(t))") }
        else if status.gated > 0 { bits.append("\(status.gated) quiet") }
        return bits.joined(separator: "  ·  ")
    }

    private func ago(_ d: Date) -> String {
        let s = Int(now.timeIntervalSince(d))
        if s < 60 { return "\(max(0, s))s ago" }
        if s < 3600 { return "\(s / 60)m ago" }
        return "\(s / 3600)h ago"
    }
}
