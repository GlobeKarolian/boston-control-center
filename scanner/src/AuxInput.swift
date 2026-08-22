import Foundation
import AVFoundation
import CoreMedia

/* ---------------------------------------------------------------- aux in ---
   The fourth kind of source: a physical input on this Mac. A scanner's
   speaker jack into the line-in, a USB capture dongle, the receiver sitting
   in a venue security office. No stream login, no browser left open; the
   setup is a cable and a one-time microphone permission.

   The shape of this class is deliberately a twin of SystemAudioTap: same
   callbacks, same 16 kHz mono Int16 segments out, same WAV framing, so
   Capture.swift arms it the same way and everything downstream, whisper, the
   gate, the relay POST, cannot tell an aux feed from a tapped one. The only
   genuinely different part is where the samples come from: AVCaptureSession
   reading a device instead of ScreenCaptureKit reading an application. */

struct AudioInputDevice: Identifiable, Equatable {
    let id: String      // the device's uniqueID, stable across reboots
    let name: String    // what System Settings calls it

    /* Every audio input this Mac can currently hear. Line-in and USB codecs
       arrive as external devices; the built-in mic is listed too because a
       receiver on the desk next to the laptop is a real, if crude, setup. */
    static func all() -> [AudioInputDevice] {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio, position: .unspecified)
        return discovery.devices.map { AudioInputDevice(id: $0.uniqueID, name: $0.localizedName) }
    }
}

final class AuxInputTap: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    var segmentSeconds: Double = 15
    var onState: ((String) -> Void)?
    var onNotice: ((String) -> Void)?
    var onFailure: ((String) -> Void)?
    var onSegment: ((Data) -> Void)?

    private var session: AVCaptureSession?
    private let queue = DispatchQueue(label: "relay.auxin")
    private var pcm: [Int16] = []
    private var carry: [Float] = []
    private var deviceUID = ""
    private var attempts = 0
    private var stopped = false
    private var lastSampleAt = Date()
    private var watchdog: Timer?
    private let mlock = NSLock()
    private var mon: AuxMonitor?

    /* The port made audible. On builds a small playback engine and feeds it
       the same mono float stream the transcriber reads; off tears it down.
       Safe to flip at any moment from any thread, capture running or not. */
    func setMonitor(_ on: Bool) {
        mlock.lock()
        if on {
            if mon == nil {
                let m = AuxMonitor()
                m.onProblem = { [weak self] why in self?.onNotice?(why) }
                mon = m
            }
        } else {
            mon?.stop()
            mon = nil
        }
        mlock.unlock()
    }

    func start(deviceUID uid: String) {
        deviceUID = uid
        stopped = false
        /* The permission prompt fires here, once per install. Denied is a
           configuration fact the operator has to fix in System Settings, so
           it is reported as a failure with the path spelled out, not retried:
           retrying a denial just re-logs it forever. */
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            guard let self else { return }
            if !granted {
                self.onFailure?("microphone access denied. System Settings -> Privacy & Security -> Microphone, allow Scanner Relay, then start capture again.")
                return
            }
            DispatchQueue.main.async { self.attach() }
        }
    }

    private func attach() {
        guard !stopped else { return }
        guard let dev = AVCaptureDevice(uniqueID: deviceUID) else {
            retry("input device not found. Is it plugged in? Pick it again if the hardware changed.")
            return
        }

        let s = AVCaptureSession()
        do {
            let input = try AVCaptureDeviceInput(device: dev)
            guard s.canAddInput(input) else { retry("could not open \(dev.localizedName)"); return }
            s.addInput(input)
        } catch {
            retry("could not open \(dev.localizedName): \(error.localizedDescription)")
            return
        }

        let out = AVCaptureAudioDataOutput()
        /* Ask for float32 mono up front so the delegate sees one predictable
           shape. The OS resamples from whatever the hardware runs at; the
           down-to-16k pass below is still ours so the averaging low-pass that
           keeps hiss out of the speech band is applied the same way it is for
           a tapped application. */
        out.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
        ]
        out.setSampleBufferDelegate(self, queue: queue)
        guard s.canAddOutput(out) else { retry("could not read from \(dev.localizedName)"); return }
        s.addOutput(out)

        session = s
        s.startRunning()
        onState?("connecting")
        onNotice?("listening to \(dev.localizedName)")

        /* A capture device that is working delivers buffers continuously,
           silence included, so a quiet stretch here means the cable or the
           device went away, not the radio. Fifteen seconds is long enough to
           survive a USB re-enumeration hiccup. */
        lastSampleAt = Date()
        DispatchQueue.main.async { [weak self] in
            self?.watchdog?.invalidate()
            self?.watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                guard let self, !self.stopped else { return }
                if Date().timeIntervalSince(self.lastSampleAt) > 15 {
                    self.teardown()
                    self.retry("no samples from the input for 15s; device unplugged?")
                }
            }
        }
    }

    private func retry(_ why: String) {
        guard !stopped else { return }
        attempts += 1
        if attempts >= 4 {
            onFailure?(why)
            return
        }
        onNotice?("\(why) Retrying in 4s (\(attempts)/3).")
        onState?("connecting")
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.attach() }
    }

    func stop() {
        stopped = true
        setMonitor(false)
        teardown()
        queue.sync { pcm = []; carry = [] }
    }

    private func teardown() {
        watchdog?.invalidate()
        watchdog = nil
        session?.stopRunning()
        session = nil
    }

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sb: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard sb.isValid, sb.numSamples > 0 else { return }
        guard let fmt = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee
        else { return }

        var mono: [Float] = []
        do {
            try sb.withAudioBufferList { list, _ in
                mono = SystemAudioTap.downmix(list, asbd: asbd)
            }
        } catch { return }
        guard !mono.isEmpty else { return }

        lastSampleAt = Date()
        attempts = 0            // samples arriving are the only proof it works

        mlock.lock(); let m = mon; mlock.unlock()
        m?.feed(mono, rate: asbd.mSampleRate)

        /* A monitor-only tap has no segment consumer. Skip the transcription
           buffer entirely so an afternoon of listening does not accumulate
           one sixteen-thousand samples at a time. */
        guard onSegment != nil else { return }

        let chunk = resample(mono, from: asbd.mSampleRate)
        guard !chunk.isEmpty else { return }
        pcm.append(contentsOf: chunk)

        let want = Int(max(5, segmentSeconds) * 16_000)
        guard pcm.count >= want else { return }
        let take = Array(pcm.prefix(want))
        pcm.removeFirst(want)
        onSegment?(SystemAudioTap.wav(take))
    }

    /* Same crude-but-honest downsample the application tap uses: average each
       group so the high end does not fold into the speech band, and carry the
       tail so phase never drifts across a segment boundary. Duplicated from
       SystemAudioTap rather than shared because each keeps its own carry. */
    private func resample(_ chunk: [Float], from rate: Double) -> [Int16] {
        let source = rate > 0 ? rate : 48_000
        var input = carry
        input.append(contentsOf: chunk)
        carry = []

        let step = max(1.0, source / 16_000.0)
        var out: [Int16] = []
        out.reserveCapacity(Int(Double(input.count) / step) + 1)

        var pos = 0.0
        while Int(pos + step) <= input.count {
            let a = Int(pos)
            let b = max(a + 1, Int(pos + step))
            var acc: Float = 0
            for j in a ..< b { acc += input[j] }
            let v = acc / Float(b - a) * 32_767
            out.append(Int16(max(-32_767, min(32_767, v))))
            pos += step
        }

        let consumed = Int(pos)
        if consumed < input.count { carry = Array(input[consumed...]) }
        return out
    }
}

/* ------------------------------------------------------------- monitor ---
   Playback for the operator's ears: the mono float stream, scheduled onto
   whatever this Mac's default output is. Kept deliberately dumb: no volume,
   no routing, and at most a second of queue, so a stall drops sound instead
   of drifting ever further behind the radio. What you hear during capture
   is exactly what whisper is handed. */
final class AuxMonitor {
    var onProblem: ((String) -> Void)?

    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var rate: Double = 0
    private var queuedFrames = 0
    private var complained = false

    func feed(_ mono: [Float], rate r: Double) {
        guard !mono.isEmpty, r > 0 else { return }
        lock.lock()
        if rate == 0 || abs(rate - r) > 1 { build(r) }
        guard let eng = engine, let ply = player, eng.isRunning,
              queuedFrames < Int(r),        // at most ~1s behind live
              let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: r,
                                      channels: 1, interleaved: false),
              let buf = AVAudioPCMBuffer(pcmFormat: fmt,
                                         frameCapacity: AVAudioFrameCount(mono.count)),
              let dst = buf.floatChannelData?[0]
        else { lock.unlock(); return }
        buf.frameLength = AVAudioFrameCount(mono.count)
        mono.withUnsafeBufferPointer { src in
            memcpy(dst, src.baseAddress!, mono.count * MemoryLayout<Float>.size)
        }
        queuedFrames += mono.count
        lock.unlock()
        ply.scheduleBuffer(buf) { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.queuedFrames -= mono.count; self.lock.unlock()
        }
    }

    /* Called with the lock held. A failed start is remembered by rate so it
       is not retried per buffer; toggling listen off and on makes a fresh
       monitor and a fresh attempt. */
    private func build(_ r: Double) {
        rate = r
        player?.stop()
        engine?.stop()
        engine = nil; player = nil; queuedFrames = 0
        guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: r,
                                      channels: 1, interleaved: false) else { return }
        let eng = AVAudioEngine()
        let ply = AVAudioPlayerNode()
        eng.attach(ply)
        eng.connect(ply, to: eng.mainMixerNode, format: fmt)
        do {
            try eng.start()
            ply.play()
            engine = eng
            player = ply
        } catch {
            if !complained {
                complained = true
                onProblem?("cannot play the input aloud: \(error.localizedDescription)")
            }
        }
    }

    func stop() {
        lock.lock()
        player?.stop()
        engine?.stop()
        engine = nil; player = nil; queuedFrames = 0
        lock.unlock()
    }
}
