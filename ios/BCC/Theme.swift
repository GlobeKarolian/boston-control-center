// Theme.swift
//
// The board's palette, both halves of it. web/app/index.html paints every
// colour as a light-dark() pair and PAL in its script carries the same pairs
// for the map's vectors; these are those numbers, so a call that is scanner
// green on the wall is the same green in a pocket. The app follows the
// system appearance the way the board's "auto" does.

import SwiftUI

extension Color {
    init(light: String, dark: String) {
        self = Color(UIColor { trait in
            UIColor(hex: trait.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

extension UIColor {
    convenience init(hex: String) {
        var h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if h.hasPrefix("#") { h.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: h).scanHexInt64(&v)
        let r = CGFloat((v >> 16) & 0xFF) / 255
        let g = CGFloat((v >> 8) & 0xFF) / 255
        let b = CGFloat(v & 0xFF) / 255
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}

enum Pal {
    /* PAL.dark / PAL.light from index.html, verbatim. */
    static let scanner = Color(light: "#0d6b45", dark: "#34d399")
    static let crash   = Color(light: "#c8102e", dark: "#ff4d4d")
    static let road    = Color(light: "#a86a00", dark: "#ffb020")
    static let alert   = Color(light: "#6a35a0", dark: "#c07cff")
    static let transit = Color(light: "#0b52a8", dark: "#4da3ff")
    static let fire    = Color(light: "#c2410c", dark: "#ff6b3d")
    static let wire    = Color(light: "#b3261e", dark: "#ff3b30")

    static let bg      = Color(light: "#f5f3ef", dark: "#06090f")
    static let panel   = Color(light: "#fffdfa", dark: "#0d131d")
    static let sunk    = Color(light: "#ebe7e0", dark: "#0a0f17")
    static let border  = Color(light: "#dbd5ca", dark: "#1d2634")
    static let ink     = Color(light: "#16181c", dark: "#e8edf4")
    static let dim     = Color(light: "#575d69", dark: "#8fa0b4")
    static let faint   = Color(light: "#8a8f9a", dark: "#5c6b7f")

    /* The chip a severity wears, matching the shift page. */
    static func sev(_ s: Double?) -> Color {
        let v = s ?? 0
        if v >= 4 { return wire }
        if v >= 3 { return road }
        return transit
    }

    /* One colour per kind of call, the board's own mapping. */
    static func type(_ t: String?) -> Color {
        let s = (t ?? "").lowercased()
        if s.contains("fire") || s.contains("smoke") { return fire }
        if s.contains("shoot") || s.contains("stab") || s.contains("weapon") || s.contains("robbery") || s.contains("assault") { return wire }
        if s.contains("crash") || s.contains("mva") || s.contains("pedestrian") { return crash }
        if s.contains("pursuit") || s.contains("chase") { return transit }
        return scanner
    }
}

/* The little uppercase chip every surface uses. */
struct Chip: View {
    var text: String
    var color: Color = Pal.dim
    var filled: Bool = false

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .tracking(0.5)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .foregroundStyle(filled ? Color.white : color)
            .background(filled ? color : color.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}

/* The LIVE chip, with the same steady meaning as the shift page. */
struct LiveChip: View {
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Pal.scanner).frame(width: 6, height: 6)
            Text("LIVE").font(.system(size: 10, weight: .bold, design: .monospaced))
        }
        .padding(.horizontal, 7).padding(.vertical, 2)
        .foregroundStyle(Pal.scanner)
        .background(Pal.scanner.opacity(0.14))
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}

/* The one line of legal weight, carried on every surface the way the
   dashboard header carries it. Machine-transcribed, machine-located. */
struct Unverified: View {
    var body: some View {
        Text("UNVERIFIED · NOT FOR PUBLICATION")
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .tracking(1)
            .foregroundStyle(Pal.road)
    }
}


/* The Reflection, drawn in code so it ships no asset and stays crisp at any
   size: the city above the waterline, its voice below. Same mark as the
   favicon and the home-screen icon. */
struct LogoMark: View {
    var size: CGFloat = 30
    private let slate = Color(red: 0x23/255, green: 0x30/255, blue: 0x43/255)
    private let mastc = Color(red: 0x3A/255, green: 0x4A/255, blue: 0x63/255)
    private let water = Color(red: 0x2B/255, green: 0x38/255, blue: 0x50/255)

    var body: some View {
        Canvas { ctx, sz in
            let u = sz.width / 100
            func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ c: Color) {
                ctx.fill(Path(CGRect(x: x * u, y: y * u, width: w * u, height: h * u)), with: .color(c))
            }
            box(11, 44, 7, 12, slate); box(20, 26, 12, 30, slate)
            box(34, 40, 7, 16, slate); box(43, 31, 11, 25, slate)
            box(57, 36, 5, 20, slate); box(65, 41, 9, 15, slate)
            var tip = Path()
            tip.move(to: CGPoint(x: 65 * u, y: 41 * u))
            tip.addLine(to: CGPoint(x: 74 * u, y: 41 * u))
            tip.addLine(to: CGPoint(x: 69.5 * u, y: 33 * u))
            tip.closeSubpath()
            ctx.fill(tip, with: .color(slate))
            box(77, 47, 8, 9, slate)
            box(47.7, 22, 1.8, 9, mastc)
            ctx.fill(Path(ellipseIn: CGRect(x: 46.4 * u, y: 17.4 * u, width: 4.4 * u, height: 4.4 * u)), with: .color(Pal.road))
            box(8, 57.2, 81, 1.8, water)
            let bars: [(CGFloat, CGFloat)] = [(19, 77), (25, 86), (31, 72), (43, 80), (49, 90), (55, 71), (61, 75), (67, 83), (77, 72)]
            for (x, yEnd) in bars {
                let r = Path(roundedRect: CGRect(x: (x - 2.2) * u, y: 64 * u, width: 4.4 * u, height: (yEnd - 64) * u), cornerRadius: 2.2 * u)
                ctx.fill(r, with: .color(Pal.scanner))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/* The masthead. One strip over every tab, the same identity the wall leads
   with: the live dot, the name in the masthead's serif, the legal line, and
   the newsroom clock in Eastern. This is most of what makes the app read as
   the product rather than as a template with pins on it. */
struct Masthead: View {
    @ObservedObject var board = Board.shared

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                LogoMark(size: 30)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Boston Control Center")
                        .font(.system(size: 15, weight: .semibold, design: .serif))
                        .foregroundStyle(Pal.ink)
                        .lineLimit(1).minimumScaleFactor(0.8)
                    Unverified()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 1) {
                    /* The clock is the live indicator now: green while the
                       board answers, amber while it does not. */
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(ETime.clockNow(ctx.date))
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundStyle(board.problem == nil ? Pal.scanner : Pal.road)
                    }
                    Text(feedsLine)
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .tracking(0.5)
                        .foregroundStyle(board.feedsOffline > 0 ? Pal.road : Pal.faint)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .padding(.bottom, 8)
            .background(Pal.bg)
            Rectangle().frame(height: 1).foregroundStyle(Pal.border)
        }
    }

    private var feedsLine: String {
        guard board.feedsTotal > 0 else { return "FEEDS —" }
        let on = board.feedsTotal - board.feedsOffline
        return "\(on)/\(board.feedsTotal) FEEDS"
    }
}
