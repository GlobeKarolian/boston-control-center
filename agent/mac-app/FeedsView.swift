import SwiftUI

enum Format {
    static func ago(_ iso: String?) -> String {
        guard let s = iso, let d = AgentStatus.iso.date(from: s) else { return "never" }
        let t = Date().timeIntervalSince(d)
        if t < 2 { return "now" }
        if t < 90 { return "\(Int(t))s ago" }
        if t < 5400 { return "\(Int(t / 60))m ago" }
        return "\(Int(t / 3600))h ago"
    }
}

struct LevelBar: View {
    var level: Double
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.15))
                Capsule()
                    .fill(level > 0.02 ? Color.green : Color.secondary.opacity(0.4))
                    .frame(width: max(2, g.size.width * min(1, level * 4)))
                    .animation(.easeOut(duration: 0.25), value: level)
            }
        }
        .frame(width: 54, height: 5)
    }
}

struct FeedRow: View {
    @EnvironmentObject var control: AgentControl
    var feed: Feed
    var onEdit: () -> Void

    private var live: SourceStatus? { control.statusFor(feed.id) }

    var body: some View {
        HStack(spacing: 12) {
            Toggle("", isOn: Binding(
                get: { feed.enabled },
                set: { _ in control.toggle(feed) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)

            Image(systemName: feed.kind == .broadcastify ? "antenna.radiowaves.left.and.right" : "waveform")
                .foregroundStyle(feed.enabled ? Color.accentColor : .secondary)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 2) {
                Text(feed.label).fontWeight(.medium)
                HStack(spacing: 6) {
                    Text(feed.subtitle)
                    if let p = feed.problem {
                        Text(p).foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if feed.enabled, let s = live {
                HStack(spacing: 14) {
                    LevelBar(level: s.peakLast ?? 0)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(s.clips ?? 0) clips, \(s.gated ?? 0) quiet")
                        Text("text " + Format.ago(s.lastTextAt))
                    }
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    Circle()
                        .fill(dotColor(s))
                        .frame(width: 8, height: 8)
                        .help(s.lastError ?? s.status ?? "")
                }
            } else if feed.enabled {
                Text(control.state == .capturing ? "waiting" : "off air")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Button(action: onEdit) { Image(systemName: "slider.horizontal.3") }
                .buttonStyle(.borderless)
                .help("Edit this feed")
        }
        .padding(.vertical, 5)
        .opacity(feed.enabled ? 1 : 0.55)
        .contextMenu {
            Button("Edit", action: onEdit)
            Button(feed.enabled ? "Turn off" : "Turn on") { control.toggle(feed) }
            Divider()
            Button("Remove", role: .destructive) { control.remove([feed.id]) }
        }
    }

    private func dotColor(_ s: SourceStatus) -> Color {
        if s.lastError != nil { return .red }
        if (s.clips ?? 0) == 0 { return .orange }
        return .green
    }
}

struct FeedsView: View {
    @EnvironmentObject var control: AgentControl
    @State private var editing: Feed?
    @State private var adding = false

    var body: some View {
        VStack(spacing: 0) {
            List {
                Section("Scanner feeds") {
                    ForEach(control.feeds.filter { $0.kind == .broadcastify }) { f in
                        FeedRow(feed: f) { editing = f }
                    }
                }
                Section("App and browser audio") {
                    ForEach(control.feeds.filter { $0.kind == .audiotap }) { f in
                        FeedRow(feed: f) { editing = f }
                    }
                }
            }
            .listStyle(.inset)

            Divider()
            HStack {
                Button {
                    adding = true
                } label: {
                    Label("Add feed", systemImage: "plus")
                }
                Text("\(control.enabledFeeds.count) on")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                if control.configChanged && control.state != .stopped && control.state != .notInstalled {
                    Text("Changes are not live yet")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            .padding(10)
        }
        .sheet(item: $editing) { f in
            FeedEditor(feed: f, isNew: false) { control.update($0) }
        }
        .sheet(isPresented: $adding) {
            FeedEditor(feed: Feed(id: "", label: "", city: "Boston", kind: .broadcastify,
                                  feed: "", app: "", system: false, enabled: true),
                       isNew: true) { control.add($0) }
        }
    }
}

struct FeedEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var feed: Feed
    var isNew: Bool
    var save: (Feed) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(isNew ? "Add a feed" : "Edit feed").font(.headline).padding()
            Divider()
            Form {
                TextField("Name", text: $feed.label)
                    .onChange(of: feed.label) { _, new in
                        if isNew { feed.id = Feed.slug(new) }
                    }
                TextField("City", text: $feed.city)
                Picker("Source", selection: $feed.kind) {
                    ForEach(FeedKind.allCases) { k in Text(k.title).tag(k) }
                }
                .pickerStyle(.radioGroup)

                if feed.kind == .broadcastify {
                    TextField("Broadcastify feed id", text: $feed.feed)
                    Text("The number in broadcastify.com/listen/feed/46343. Boston Fire is 46343, Boston EMS 36636, Cambridge 36665, Mass State Police 3969.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Toggle("Everything this Mac is playing", isOn: $feed.system)
                    if !feed.system {
                        TextField("App name", text: $feed.app)
                        Text("Type the app exactly as it appears in the Applications folder, for example Google Chrome. The whole process family is tapped, which is what catches a tab rendering audio in a helper process.")
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if !isNew {
                    TextField("Internal id", text: $feed.id)
                        .disabled(true)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                if let p = feed.problem {
                    Label(p, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
                Spacer()
                Button("Cancel") { dismiss() }
                Button(isNew ? "Add" : "Save") { save(feed); dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(feed.problem != nil)
            }
            .padding()
        }
        .frame(width: 460)
    }
}
