import Foundation

/* An Icecast stream is an endless run of MPEG audio frames. Slicing it on a
   wall clock timer cuts frames in half, and half a frame at the front of a file
   is what makes a decoder reject the whole thing. So the byte stream is parsed
   into whole frames here, and every segment handed downstream begins on a sync
   word and ends on a frame boundary. It also gives an exact duration for free,
   which beats guessing from byte counts at a variable bitrate. */
final class MP3Framer {

    private static let bitrateV1L3 = [0, 32, 40, 48, 56, 64, 80, 96,
                                      112, 128, 160, 192, 224, 256, 320, 0]
    private static let bitrateV2L3 = [0, 8, 16, 24, 32, 40, 48, 56,
                                      64, 80, 96, 112, 128, 144, 160, 0]
    private static let rateV1 = [44100, 48000, 32000, 0]
    private static let rateV2 = [22050, 24000, 16000, 0]
    private static let rateV25 = [11025, 12000, 8000, 0]

    private var buf = [UInt8]()
    private var pending = [UInt8]()
    private var pendingSeconds = 0.0

    /// Bytes seen that never yielded a valid frame. A stream that is not MPEG
    /// audio at all shows up here instead of silently buffering forever.
    private(set) var junkBytes = 0

    func append(_ d: Data) { buf.append(contentsOf: d) }

    /// Pulls whole frames until at least `seconds` of audio has accumulated.
    /// Returns nil while the segment is still filling.
    func drain(seconds: Double) -> (data: Data, duration: Double)? {
        var i = 0
        while i + 4 <= buf.count {
            guard let f = frame(at: i) else {
                i += 1
                junkBytes += 1
                if junkBytes > 1 << 20 { junkBytes = 1 << 20 }
                continue
            }
            guard i + f.length <= buf.count else { break }   // frame not fully arrived
            pending.append(contentsOf: buf[i ..< (i + f.length)])
            pendingSeconds += f.seconds
            junkBytes = 0
            i += f.length

            if pendingSeconds >= seconds {
                buf.removeFirst(i)
                let out = (Data(pending), pendingSeconds)
                pending.removeAll(keepingCapacity: true)
                pendingSeconds = 0
                return out
            }
        }
        if i > 0 { buf.removeFirst(i) }

        /* A stream that is neither MPEG nor recoverable must not grow without
           bound. Keep the tail so a sync word straddling the cut still lands. */
        if buf.count > 1 << 21 { buf.removeFirst(buf.count - 4096) }
        return nil
    }

    func reset() {
        buf.removeAll(keepingCapacity: false)
        pending.removeAll(keepingCapacity: false)
        pendingSeconds = 0
        junkBytes = 0
    }

    private struct Frame { let length: Int; let seconds: Double }

    private func frame(at i: Int) -> Frame? {
        guard i + 4 <= buf.count else { return nil }
        let b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2]
        guard b0 == 0xFF, (b1 & 0xE0) == 0xE0 else { return nil }

        let versionBits = (b1 >> 3) & 0x03      // 00 = 2.5, 01 = reserved, 10 = 2, 11 = 1
        let layerBits   = (b1 >> 1) & 0x03      // 01 = Layer III
        guard versionBits != 0x01, layerBits == 0x01 else { return nil }

        let brIndex = Int((b2 >> 4) & 0x0F)
        let srIndex = Int((b2 >> 2) & 0x03)
        let padding = Int((b2 >> 1) & 0x01)
        guard brIndex > 0, brIndex < 15, srIndex < 3 else { return nil }

        let isV1 = versionBits == 0x03
        let bitrate = (isV1 ? Self.bitrateV1L3[brIndex] : Self.bitrateV2L3[brIndex]) * 1000
        let rate: Int
        switch versionBits {
        case 0x03: rate = Self.rateV1[srIndex]
        case 0x02: rate = Self.rateV2[srIndex]
        default:   rate = Self.rateV25[srIndex]
        }
        guard bitrate > 0, rate > 0 else { return nil }

        let samples = isV1 ? 1152 : 576
        let length = (isV1 ? 144 * bitrate / rate : 72 * bitrate / rate) + padding
        guard length > 4, length < 4096 else { return nil }

        /* One header is a coincidence. Two in a row is a stream. Checking that
           the next frame lands exactly where this one says it will is what keeps
           a random 0xFF inside album art from being read as audio. */
        if i + length + 2 <= buf.count {
            let n0 = buf[i + length], n1 = buf[i + length + 1]
            guard n0 == 0xFF, (n1 & 0xE0) == 0xE0 else { return nil }
        }

        return Frame(length: length, seconds: Double(samples) / Double(rate))
    }
}
