import Foundation
import AVFoundation
import ScreenCaptureKit
import IOKit.pwr_mgt

/* ------------------------------------------------------------ staying awake --- */

/* A relay that goes to sleep is a relay that misses the call, and idle sleep
   takes every feed down at once, not just the tapped one. Worse on a Mac
   driving a television: the application tap is built around a display, so the
   screen going dark takes the tap with it.

   So capture holds the machine awake while it runs, and holds the screen awake
   too when something is being tapped. Both assertions die with the process, so
   a crash cannot leave a Mac that refuses to sleep forever. */
enum Wakefulness {
    private static let lock = NSLock()
    private static var systemID: IOPMAssertionID = 0
    private static var screenID: IOPMAssertionID = 0
    private static var holdingSystem = false
    private static var holdingScreen = false

    static func hold(screenToo: Bool) {
        lock.lock(); defer { lock.unlock() }
        if !holdingSystem {
            holdingSystem = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "Scanner Relay is capturing" as CFString,
                &systemID) == kIOReturnSuccess
        }
        if screenToo && !holdingScreen {
            holdingScreen = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "Scanner Relay is tapping application audio" as CFString,
                &screenID) == kIOReturnSuccess
        }
    }

    static func release() {
        lock.lock(); defer { lock.unlock() }
        if holdingSystem { IOPMAssertionRelease(systemID); holdingSystem = false }
        if holdingScreen { IOPMAssertionRelease(screenID); holdingScreen = false }
    }

    static var describe: String {
        lock.lock(); defer { lock.unlock() }
        if holdingScreen { return "machine and screen held awake" }
        if holdingSystem { return "machine held awake" }
        return "sleep allowed"
    }
}

/* --------------------------------------------------------------- app audio --- */

/* Boston Police is not on Broadcastify, so the only way in is to let a browser
   play the stream and take the sound back out of the machine. ScreenCaptureKit
   taps one application's audio with nothing installed: no virtual sound device,
   no kernel extension, no cables to route by hand. The operator grants screen
   recording once and picks Chrome from a list.

   The tap hands back forty eight kilohertz stereo float. Whisper wants sixteen
   kilohertz mono sixteen bit, so the conversion happens here rather than by
   shelling out, which keeps this path shorter than the Broadcastify one. */

struct AudioApp: Identifiable, Hashable {
    let id: String          // bundle identifier
    let name: String
}

enum SystemAudio {
    /// Everything running that ScreenCaptureKit is willing to tap. Asking this
    /// question is also what triggers the one time permission prompt.
    static func running(_ done: @escaping ([AudioApp], String?) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            if let error {
                DispatchQueue.main.async { done([], error.localizedDescription) }
                return
            }
            var seen = Set<String>()
            var out: [AudioApp] = []
            for a in content?.applications ?? [] {
                let bid = a.bundleIdentifier
                guard !bid.isEmpty, !seen.contains(bid) else { continue }
                seen.insert(bid)
                out.append(AudioApp(id: bid,
                                    name: a.applicationName.isEmpty ? bid : a.applicationName))
            }
            out.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            DispatchQueue.main.async { done(out, nil) }
        }
    }

    /// The browsers worth offering first, since that is what this is for.
    static let preferred = ["com.google.Chrome", "com.apple.Safari",
                            "com.microsoft.edgemac", "org.mozilla.firefox",
                            "com.brave.Browser", "company.thebrowser.Browser"]
}

final class SystemAudioTap: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "relay.systemaudio")
    private var stream: SCStream?
    private var pcm: [Int16] = []
    private var carry: [Float] = []

    /* Every piece of lifecycle state below is touched only on `queue`, which is
       also the queue ScreenCaptureKit delivers samples on. One serial queue
       owning all of it means no locks and no torn reads between the delegate
       callbacks, the retry timer and the watchdog. */
    private var wanted = false          // capture is supposed to be running
    private var live = false            // the stream said it started
    private var bundle = ""
    private var attempts = 0
    private var toldAboutPermission = false
    private var watchdog: DispatchSourceTimer?

    var segmentSeconds: Double = 15
    var onSegment: ((Data) -> Void)?        // a finished 16 kHz mono WAV
    var onState: ((String) -> Void)?
    var onFailure: ((String) -> Void)?      // needs a person to do something
    var onNotice: ((String) -> Void)?       // temporary, already being retried
    private(set) var lastSampleAt: Date?

    func start(bundleID: String) {
        queue.async { [weak self] in
            guard let self else { return }
            self.wanted = true
            self.bundle = bundleID
            self.attempts = 0
            self.toldAboutPermission = false
            self.attach()
            self.beginWatchdog()
        }
    }

    /* One attempt at building the tap. Everything that can go wrong here is
       something that fixes itself later: the browser has not launched, the
       television is switched off so the Mac reports no display, permission was
       granted a moment ago and the daemon has not caught up. So nothing here
       gives up. It reports what it saw and asks to be tried again. */
    private func attach() {
        guard wanted else { return }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
            guard let self else { return }
            self.queue.async {
                guard self.wanted else { return }
                if let error {
                    /* Permission is the one thing a retry will not fix on its
                       own, so it gets said plainly, once. */
                    if !self.toldAboutPermission {
                        self.toldAboutPermission = true
                        self.onFailure?("screen recording permission is needed to tap application audio. "
                                        + "Grant it in System Settings, Privacy and Security, Screen Recording, "
                                        + "then quit and reopen Scanner Relay.")
                    }
                    self.retry("screen recording is not permitted yet (\(error.localizedDescription))")
                    return
                }
                guard let content else {
                    self.retry("could not read what is running on this Mac")
                    return
                }
                /* A Mac driving a television reports no display the moment that
                   television is switched off, and an application filter is built
                   around a display. It comes back when the screen does. */
                guard let display = content.displays.first else {
                    self.retry("this Mac reports no display right now, and an application audio tap needs one. "
                               + "A display emulator dongle keeps it from ever going away")
                    return
                }
                let apps = content.applications.filter { $0.bundleIdentifier == self.bundle }
                guard !apps.isEmpty else {
                    self.retry("\(self.bundle) is not running, so there is nothing to listen to yet")
                    return
                }
                self.begin(display: display, apps: apps)
            }
        }
    }

    /* Backing off rather than hammering, and going quiet in the log rather than
       writing the same line a thousand times to a Mac nobody is watching. */
    private func retry(_ why: String) {
        guard wanted else { return }
        teardown()
        live = false
        attempts += 1
        let wait = min(30.0, pow(2.0, Double(min(attempts, 5))))
        if attempts <= 3 || attempts % 10 == 0 {
            onNotice?("\(why). Trying again in \(Int(wait))s")
        }
        onState?("connecting")
        queue.asyncAfter(deadline: .now() + wait) { [weak self] in self?.attach() }
    }

    /* A tap can die without ever saying so: the browser is relaunched, the tab
       is closed, the Mac wakes with the stream already gone. All of that looks
       identical from in here, which is to say it looks like silence. So silence
       is what gets watched. Two minutes without a single sample while the tap
       believes it is live means rebuild it, rather than sit there reporting
       health on a stream that stopped feeding. */
    private func beginWatchdog() {
        watchdog?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 30, repeating: 30)
        t.setEventHandler { [weak self] in
            guard let self, self.wanted, self.live else { return }
            let quiet = Date().timeIntervalSince(self.lastSampleAt ?? .distantPast)
            guard quiet > 120 else { return }
            self.onNotice?("no sound out of \(self.bundle) for two minutes, rebuilding the tap")
            self.attempts = 0
            self.retry("the tap went quiet")
        }
        t.resume()
        watchdog = t
    }

    private func begin(display: SCDisplay, apps: [SCRunningApplication]) {
        let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        cfg.excludesCurrentProcessAudio = true
        /* No screen output is attached, so these only exist to keep the
           configuration valid. Nothing draws them and nothing reads them. */
        cfg.width = 100
        cfg.height = 100
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.queueDepth = 5

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        } catch {
            retry("could not attach the audio tap (\(error.localizedDescription))")
            return
        }
        stream = s
        s.startCapture { [weak self] err in
            guard let self else { return }
            self.queue.async {
                guard self.wanted else { return }
                if let err {
                    self.retry("could not start the audio tap (\(err.localizedDescription))")
                } else {
                    self.live = true
                    self.lastSampleAt = Date()      // start the silence clock now
                    self.onState?("live")
                }
            }
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.wanted = false
            self.live = false
            self.watchdog?.cancel()
            self.watchdog = nil
            self.teardown()
            self.pcm = []
            self.carry = []
        }
    }

    private func teardown() {
        let s = stream
        stream = nil
        s?.stopCapture { _ in }
    }

    /* The system stops the stream for reasons that have nothing to do with this
       app: the display slept, the television was switched off, the browser was
       relaunched, the Mac woke up. Every one of those passes. The only wrong
       answer is to sit there stopped, which is what this used to do. */
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { [weak self] in
            guard let self, self.wanted else { return }
            self.retry("the audio tap stopped (\(error.localizedDescription))")
        }
    }
}

// MARK: - sample handling

extension SystemAudioTap {

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid, sb.numSamples > 0 else { return }
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
        attempts = 0            // sound arriving is the only proof the tap works
        let chunk = resample(mono, from: asbd.mSampleRate)
        guard !chunk.isEmpty else { return }
        pcm.append(contentsOf: chunk)

        let want = Int(max(5, segmentSeconds) * 16_000)
        guard pcm.count >= want else { return }
        let take = Array(pcm.prefix(want))
        pcm.removeFirst(want)
        onSegment?(SystemAudioTap.wav(take))
    }

    /* Two shapes arrive depending on the version and the source: one buffer per
       channel, or a single interleaved buffer. Both collapse to mono here. */
    static func downmix(_ list: UnsafeMutableAudioBufferListPointer,
                        asbd: AudioStreamBasicDescription) -> [Float] {
        guard (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 else { return [] }

        if list.count > 1 {
            let frames = Int(list[0].mDataByteSize) / MemoryLayout<Float>.size
            guard frames > 0 else { return [] }
            var out = [Float](repeating: 0, count: frames)
            var used = 0
            for b in 0 ..< list.count {
                guard let p = list[b].mData?.assumingMemoryBound(to: Float.self) else { continue }
                let n = min(frames, Int(list[b].mDataByteSize) / MemoryLayout<Float>.size)
                for i in 0 ..< n { out[i] += p[i] }
                used += 1
            }
            if used > 1 {
                let k = 1 / Float(used)
                for i in 0 ..< frames { out[i] *= k }
            }
            return out
        }

        guard let p = list[0].mData?.assumingMemoryBound(to: Float.self) else { return [] }
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let frames = (Int(list[0].mDataByteSize) / MemoryLayout<Float>.size) / channels
        guard frames > 0 else { return [] }
        if channels == 1 { return Array(UnsafeBufferPointer(start: p, count: frames)) }
        var out = [Float](repeating: 0, count: frames)
        for i in 0 ..< frames {
            var acc: Float = 0
            for c in 0 ..< channels { acc += p[i * channels + c] }
            out[i] = acc / Float(channels)
        }
        return out
    }
}

extension SystemAudioTap {

    /* Forty eight kilohertz down to sixteen. Averaging every group of input
       samples rather than picking one of them is a crude low pass, which is
       what keeps the high end from folding back down into the speech band as
       noise. The leftover tail carries into the next buffer so the phase never
       drifts across a segment boundary. */
    func resample(_ chunk: [Float], from rate: Double) -> [Int16] {
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

    /* whisper reads a file, so the samples need a header. Writing the forty
       four bytes by hand is shorter than any framework that would do it. */
    static func wav(_ samples: [Int16]) -> Data {
        func le32(_ v: UInt32) -> [UInt8] {
            [UInt8(v & 0xff), UInt8((v >> 8) & 0xff),
             UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]
        }
        func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)] }

        let bytes = UInt32(samples.count * 2)
        var d = Data(capacity: Int(bytes) + 44)
        d.append(contentsOf: Array("RIFF".utf8))
        d.append(contentsOf: le32(36 + bytes))
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8))
        d.append(contentsOf: le32(16))
        d.append(contentsOf: le16(1))           // uncompressed PCM
        d.append(contentsOf: le16(1))           // mono
        d.append(contentsOf: le32(16_000))      // sample rate
        d.append(contentsOf: le32(32_000))      // byte rate
        d.append(contentsOf: le16(2))           // block align
        d.append(contentsOf: le16(16))          // bits per sample
        d.append(contentsOf: Array("data".utf8))
        d.append(contentsOf: le32(bytes))
        let raw = samples.withUnsafeBytes { Data($0) }
        d.append(raw)
        return d
    }
}
