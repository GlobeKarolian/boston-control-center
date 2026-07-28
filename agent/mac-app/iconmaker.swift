import AppKit
import Foundation

// Draws the app icon at every size an iconset needs. Run at build time so the
// repository carries no binary art.

func color(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

func render(_ size: CGFloat) -> Data? {
    let px = Int(size)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                     isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0),
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    rep.size = NSSize(width: size, height: size)

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx

    let inset = size * 0.06
    let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
    let shell = NSBezierPath(roundedRect: body, xRadius: size * 0.21, yRadius: size * 0.21)
    NSGradient(starting: color(0x13334f), ending: color(0x061120))?
        .draw(in: shell, angle: -90)

    shell.lineWidth = size * 0.012
    color(0xffffff, 0.10).setStroke()
    shell.stroke()

    let cx = size * 0.5
    let cy = size * 0.36
    for (i, r) in [0.16, 0.255, 0.35].enumerated() {
        let arc = NSBezierPath()
        arc.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: size * CGFloat(r),
                      startAngle: 34, endAngle: 146)
        arc.lineWidth = size * 0.052
        arc.lineCapStyle = .round
        color(0xff5a4d, 1.0 - CGFloat(i) * 0.22).setStroke()
        arc.stroke()
    }

    color(0xffd166).setFill()
    let dot = size * 0.062
    NSBezierPath(ovalIn: NSRect(x: cx - dot, y: cy - dot, width: dot * 2, height: dot * 2)).fill()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: iconmaker <output.iconset>\n".data(using: .utf8)!)
    exit(2)
}
let dir = URL(fileURLWithPath: args[1])
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

let plan: [(String, CGFloat)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
for (name, size) in plan {
    guard let data = render(size) else { exit(1) }
    try data.write(to: dir.appendingPathComponent(name))
}
print("iconset written to \(dir.path)")
