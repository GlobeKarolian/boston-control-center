import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var control: AgentControl
    @State private var ingest = ""
    @State private var bfUser = ""
    @State private var bfPass = ""
    @State private var testing = false
    @State private var result: String?
    @State private var doctor: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {

                group("This machine") {
                    LabeledContent("Name") {
                        TextField("", text: $control.settings.machine)
                            .frame(width: 260)
                    }
                    Text("Shown on the dashboard next to the feeds this Mac carries. Give each machine its own name.")
                        .font(.caption).foregroundStyle(.secondary)

                    LabeledContent("Dashboard") {
                        TextField("https://your-app.vercel.app", text: $control.settings.endpoint)
                            .frame(width: 320)
                    }
                }

                group("Keys") {
                    LabeledContent("Ingest key") {
                        HStack {
                            SecureField(control.hasIngestToken ? "A key is saved" : "Paste the key for this machine",
                                        text: $ingest)
                                .frame(width: 260)
                            Button("Save") {
                                control.saveIngestToken(ingest); ingest = ""
                            }
                            .disabled(ingest.isEmpty)
                        }
                    }
                    HStack(spacing: 6) {
                        Image(systemName: control.hasIngestToken ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(control.hasIngestToken ? .green : .secondary)
                        Text(control.hasIngestToken
                             ? "Saved to a file only your account can read. It is never displayed again."
                             : "One of the tokens from INGEST_TOKENS on Vercel.")
                            .font(.caption).foregroundStyle(.secondary)
                    }

                    LabeledContent("Broadcastify") {
                        HStack {
                            TextField("username", text: $bfUser).frame(width: 130)
                            SecureField(control.hasBroadcastifyLogin ? "A login is saved" : "password",
                                        text: $bfPass).frame(width: 130)
                            Button("Save") {
                                control.saveBroadcastifyLogin(user: bfUser, pass: bfPass)
                                bfUser = ""; bfPass = ""
                            }
                            .disabled(bfUser.isEmpty || bfPass.isEmpty)
                        }
                    }
                    HStack(spacing: 6) {
                        Image(systemName: control.hasBroadcastifyLogin ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(control.hasBroadcastifyLogin ? .green : .secondary)
                        Text("Needed for the scanner feeds. App and browser audio does not use it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }

                    HStack {
                        Button(testing ? "Testing" : "Test connection") {
                            testing = true
                            Task {
                                result = await control.testConnection()
                                testing = false
                            }
                        }
                        .disabled(testing)
                        if let r = result {
                            Text(r).font(.caption)
                                .foregroundStyle(r.hasPrefix("Connected") ? .green : .orange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                group("Transcription") {
                    LabeledContent("Whisper model") {
                        Picker("", selection: $control.settings.whisperModel) {
                            Text("tiny.en, fastest").tag("tiny.en")
                            Text("base.en").tag("base.en")
                            Text("small.en, recommended").tag("small.en")
                            Text("medium.en, slowest").tag("medium.en")
                        }
                        .labelsHidden()
                        .frame(width: 220)
                    }
                    LabeledContent("Clip length") {
                        HStack {
                            Stepper(value: $control.settings.segmentSeconds, in: 5...60, step: 5) {
                                Text("\(control.settings.segmentSeconds) seconds")
                            }
                        }
                        .frame(width: 220)
                    }
                    LabeledContent("Scanner silence gate") {
                        HStack {
                            Slider(value: $control.settings.silenceGate, in: 0.001...0.05)
                                .frame(width: 170)
                            Text(String(format: "%.3f", control.settings.silenceGate))
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Browser silence gate") {
                        HStack {
                            Slider(value: $control.settings.audiotapGate, in: 0.0002...0.01)
                                .frame(width: 170)
                            Text(String(format: "%.4f", control.settings.audiotapGate))
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    Text("A Broadcastify channel with no traffic sends true digital silence, so the gate drops it before Whisper ever sees it. Raise the gate if quiet static is producing nonsense text, lower it if quiet transmissions are being missed.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                group("Machine setup") {
                    HStack {
                        Button("Check this Mac") {
                            doctor = "Running"
                            Task { doctor = await control.runDoctor() }
                        }
                        Button("Run full setup in Terminal") { control.openSetupInTerminal() }
                        Spacer()
                    }
                    Text("The full setup builds the Python environment and downloads the Whisper model. It takes several minutes and runs in Terminal so you can watch it.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let d = doctor {
                        ScrollView {
                            Text(d).font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(height: 180)
                        .background(Color.secondary.opacity(0.07))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
            .padding(20)
        }
        .onChange(of: control.settings) { _, _ in control.saveUIState() }
    }

    @ViewBuilder
    private func group<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
