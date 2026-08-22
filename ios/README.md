# Boston Control Center for iPhone and iPad

A native SwiftUI client for the control center: the map, the board, the shift
briefing, the archive, and the desk, over the same authenticated routes the
wall dashboard polls. No frameworks beyond Apple's, no build steps beyond
Xcode's, no state the server does not own. Delete the app and reinstall it and
the board is the board; the only things kept on the device are the server
address, the username, and the password in the Keychain.

## Running it

You need Xcode 16 or newer on the Mac (free, App Store) and an iPhone or iPad
on iOS/iPadOS 17 or newer.

1. Open `ios/BCC.xcodeproj` in Xcode.
2. Click the `BCC` project in the sidebar, then the `BCC` target, then
   **Signing & Capabilities**. Set **Team** to your Apple ID (add it under
   Xcode → Settings → Accounts if it is not there). Xcode manages the rest;
   if it complains the bundle identifier is taken, change
   `com.bostonglobe.bcc` to anything of yours.
3. Plug in the phone or iPad, pick it in the device menu at the top, press
   **Run**. First time only: the device will ask you to trust the developer
   under Settings → General → VPN & Device Management.
4. The app asks for the server, username, and password on first launch. Same
   login as the dashboard. It is stored in the device Keychain and sent only
   to that server.

With a free Apple ID the install signs for 7 days, then the app stops opening
until you press Run again from Xcode. A paid developer account ($99/yr) signs
for a year, and TestFlight becomes an option if other people at the Globe want
it on their phones without a cable.

## Audio in the background

The project declares the audio background mode, so a chain of transmissions
keeps playing with the screen locked, and clips sound even with the ringer
switch off. If Xcode's signing step strips capabilities on a free account,
check **Signing & Capabilities → Background Modes → Audio, AirPlay, and
Picture in Picture** is ticked.

## What is where

| File | What it holds |
| --- | --- |
| `BCC/BCCApp.swift` | The six tabs, the login sheet, the radio bar |
| `BCC/Models.swift` | The server's JSON shapes, all fields optional, Eastern-time formatting |
| `BCC/API.swift` | Server address + Keychain, Basic auth, one function per route |
| `BCC/Store.swift` | The board: incidents, situations, wire, pipeline, 15-second poll |
| `BCC/AudioPlayer.swift` | One shared player, chains oldest-first, the bar above the tabs |
| `BCC/Theme.swift` | The palette, the chips, and the masthead with the Eastern clock |
| `BCC/MapScreen.swift` | The map, call and situation sheets; venue calls draw squared |
| `BCC/ListenScreen.swift` | The wall of scanners: raw Broadcastify streams, several at once |
| `BCC/BoardScreen.swift` | Situations, active calls, the live wire |
| `BCC/ShiftScreen.swift` | The last-10-hours briefing: watch, major, notes |
| `BCC/ArchiveScreen.swift` | Search: understood chips, cards, matched vs context lines |
| `BCC/DeskScreen.swift` | The 20-minute read and ask-the-desk with cited audio |

The screens are thin: every judgment (what is major, what groups with what,
what the question meant) is the server's, from the same code the dashboard
uses, so the phone and the wall never disagree.

## If the project file will not open

`BCC.xcodeproj` uses Xcode 16's folder-synced project format, so any `.swift`
file dropped into `BCC/` joins the build without touching the project. If a
future Xcode refuses it: File → New → Project → iOS App (SwiftUI, no tests),
name it BCC, delete the template's `ContentView.swift` and `BCCApp.swift`,
drag everything from this `BCC/` folder in, and in the target's Info build
settings add Background Modes → Audio. That is the whole project.
