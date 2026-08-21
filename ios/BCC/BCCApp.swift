// BCCApp.swift
//
// Boston Control Center, in a pocket. Five tabs over the same authenticated
// routes the wall dashboard polls, one shared radio, one shared board. On an
// iPad the tab bar becomes a sidebar by the platform's own hand; nothing here
// branches on device.
//
// There is no state in this app the server does not own. Close it, delete it,
// reinstall it: the board is the board. The only things kept locally are the
// server address, the username, and the password in the Keychain.

import SwiftUI

@main
struct BCCApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @ObservedObject var settings = Settings.shared
    @ObservedObject var board = Board.shared
    @State private var showLogin = false

    var body: some View {
        VStack(spacing: 0) {
            Masthead()
            /* Six tabs. An iPad shows all six; an iPhone shows the first four
               and folds the rest behind More, so the order below is a ranking:
               the map, the board, the raw radio, the archive. Shift and Desk
               are sit-down reads and wear the extra tap better than the rest. */
            TabView {
                MapScreen()
                    .tabItem { Label("Map", systemImage: "map") }
                BoardScreen()
                    .tabItem { Label("Board", systemImage: "list.bullet.rectangle") }
                ListenScreen()
                    .tabItem { Label("Listen", systemImage: "dot.radiowaves.left.and.right") }
                ArchiveScreen()
                    .tabItem { Label("Archive", systemImage: "magnifyingglass") }
                ShiftScreen()
                    .tabItem { Label("Shift", systemImage: "clock.arrow.circlepath") }
                DeskScreen()
                    .tabItem { Label("Desk", systemImage: "text.bubble") }
            }
            .tint(Pal.scanner)
            RadioBar()
        }
        .background(Pal.bg)
        /* The board is a night instrument. The wall leads dark and so does
           this; the palette's light half stays for anything that needs it
           later, but the product's face is the dark one. */
        .preferredColorScheme(.dark)
        .onAppear { if !settings.configured { showLogin = true } }
        .onChange(of: board.needsLogin) { _, needs in if needs { showLogin = true } }
        .sheet(isPresented: $showLogin) {
            LoginView(done: { showLogin = false; Task { await board.refresh() } })
                .preferredColorScheme(.dark)
                .interactiveDismissDisabled(!settings.configured)
        }
    }
}

struct LoginView: View {
    @ObservedObject var settings = Settings.shared
    @ObservedObject var board = Board.shared
    var done: () -> Void
    @State private var checking = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://www.scan.boston", text: $settings.server)
                        .keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
                }
                Section("Login") {
                    TextField("username", text: $settings.username)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    SecureField("password", text: $settings.password)
                }
                if let f = failure {
                    Section { Label(f, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Pal.road) }
                }
                Section {
                    Button {
                        Task { await tryIn() }
                    } label: {
                        HStack {
                            Text(checking ? "Checking…" : "Sign in")
                            if checking { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(checking || settings.server.isEmpty || settings.username.isEmpty || settings.password.isEmpty)
                } footer: {
                    Text("The same login as the dashboard. It is stored in this device's Keychain and sent to this server only. Everything on the other side is machine-transcribed radio: unverified, not for publication.")
                }
            }
            .navigationTitle("Boston Control Center")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func tryIn() async {
        checking = true
        defer { checking = false }
        settings.save()
        do {
            _ = try await API.pipeline()
            failure = nil
            done()
        } catch {
            failure = error.localizedDescription
        }
    }
}
