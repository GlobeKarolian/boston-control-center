import SwiftUI

struct LogView: View {
    @EnvironmentObject var control: AgentControl
    @State private var filter = ""
    @State private var follow = true

    private var lines: [String] {
        let all = control.logText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard !filter.isEmpty else { return all }
        return all.filter { $0.localizedCaseInsensitiveContains(filter) }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                            Text(line)
                                .font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .foregroundStyle(color(for: line))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(i)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(8)
                }
                .onChange(of: control.logText) { _, _ in
                    if follow { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }

            Divider()
            HStack(spacing: 10) {
                TextField("Filter", text: $filter)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)
                Toggle("Follow", isOn: $follow).toggleStyle(.checkbox)
                Spacer()
                Text("Addresses and keys are stripped before anything reaches this pane")
                    .font(.caption2).foregroundStyle(.secondary)
                Button("Show file") { control.revealLog() }
            }
            .padding(10)
        }
    }

    private func color(for line: String) -> Color {
        let l = line.lowercased()
        if l.contains("error") || l.contains("failed") || l.contains("refus") { return .red }
        if l.contains("warn") || l.contains("retry") { return .orange }
        if l.contains("[stt]") || l.contains("posted") || l.contains("accepted") { return .green }
        return .primary
    }
}
