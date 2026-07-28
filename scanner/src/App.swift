import SwiftUI

@main
struct ScannerRelayApp: App {
    @StateObject private var ctl = Controller(store: Store())

    var body: some Scene {
        WindowGroup {
            ContentView(ctl: ctl, store: ctl.store)
        }
        .defaultSize(width: 820, height: 900)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) { }
        }
    }
}
