import SwiftUI
import AppKit

@main
struct BCCControlApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var control = AgentControl()

    var body: some Scene {
        Window("Boston Control Center", id: "main") {
            RootView()
                .environmentObject(control)
                .frame(minWidth: 880, minHeight: 620)
                .onAppear { control.boot() }
        }
        .windowResizability(.contentMinSize)

        MenuBarExtra {
            Text(control.state.title)
            if let s = control.status, let n = s.sources?.count {
                Text("\(n) feeds, \(s.queued ?? 0) waiting to send")
            }
            Divider()
            if control.state == .stopped || control.state == .notInstalled {
                Button("Start Capture") { Task { await control.startCapture() } }
                    .disabled(control.blocker != nil)
            } else {
                Button("Stop Capture") { Task { await control.stopCapture() } }
            }
            Button("Open Control Center") {
                NSApp.activate(ignoringOtherApps: true)
                for w in NSApp.windows where w.canBecomeMain { w.makeKeyAndOrderFront(nil) }
            }
            Divider()
            Button("Quit") { NSApp.terminate(nil) }
        } label: {
            Image(systemName: control.state == .capturing
                  ? "dot.radiowaves.left.and.right"
                  : "antenna.radiowaves.left.and.right.slash")
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    // Closing the window leaves capture running and the menu bar item in place.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { for w in app.windows where w.canBecomeMain { w.makeKeyAndOrderFront(nil) } }
        return true
    }
}

struct RootView: View {
    @EnvironmentObject var control: AgentControl
    @State private var tab = 0

    var body: some View {
        VStack(spacing: 0) {
            HeaderBar()
            Divider()
            TabView(selection: $tab) {
                FeedsView().tabItem { Label("Feeds", systemImage: "list.bullet") }.tag(0)
                LogView().tabItem { Label("Activity", systemImage: "text.alignleft") }.tag(1)
                SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }.tag(2)
            }
            .padding(.top, 6)
        }
    }
}

struct HeaderBar: View {
    @EnvironmentObject var control: AgentControl

    private var dot: Color {
        switch control.state {
        case .capturing:    return .green
        case .starting:     return .yellow
        case .stalled:      return .orange
        case .stopped:      return .secondary
        case .notInstalled: return .red
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 14) {
                HStack(spacing: 8) {
                    Circle().fill(dot).frame(width: 11, height: 11)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(control.state.title).font(.title3.weight(.semibold))
                        Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if control.configChanged && control.state != .stopped && control.state != .notInstalled {
                    Button("Apply changes") { Task { await control.applyChanges() } }
                        .controlSize(.large)
                }

                if control.state == .stopped || control.state == .notInstalled {
                    Button {
                        Task { await control.startCapture() }
                    } label: {
                        Label("Start Capture", systemImage: "play.fill").frame(width: 118)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(control.busy || control.blocker != nil)
                } else {
                    Button {
                        Task { await control.stopCapture() }
                    } label: {
                        Label("Stop Capture", systemImage: "stop.fill").frame(width: 118)
                    }
                    .controlSize(.large)
                    .disabled(control.busy)
                }
            }

            if let b = control.blocker, control.state == .stopped || control.state == .notInstalled {
                Label(b, systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.orange)
            }
            if let n = control.note {
                Text(n).font(.caption).foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var subtitle: String {
        var bits: [String] = [control.settings.machine]
        if let host = URL(string: control.settings.endpoint)?.host { bits.append(host) }
        if let s = control.status, control.state == .capturing {
            let clips = (s.sources ?? []).reduce(0) { $0 + ($1.clips ?? 0) }
            bits.append("\(clips) clips this run")
            if let q = s.queued, q > 0 { bits.append("\(q) waiting to send") }
        }
        return bits.joined(separator: "   ")
    }
}
