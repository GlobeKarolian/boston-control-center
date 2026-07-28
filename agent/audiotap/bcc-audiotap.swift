/*
  bcc-audiotap
  Boston Newsroom Control Center, audio capture helper.

  Taps the audio OUTPUT of one running process (or the whole system) and writes
  raw PCM to stdout, where the node supervisor pipes it into ffmpeg and then
  Whisper. The point is to capture a scanner feed that only exists inside a
  browser tab, BPD being the one that started this.

  Why a Core Audio process tap and not the usual approaches:

    - macOS exposes no loopback input device. ffmpeg's avfoundation backend can
      only see microphones, so there is no way to reach system output with
      ffmpeg alone. Checked on this machine: it sees two mics and nothing else.
    - BlackHole and friends work, but they mean shipping a HAL driver install to
      every newsroom Mac and then walking someone through building a
      Multi-Output Device in Audio MIDI Setup. That is not an install anyone
      completes on their own.
    - ScreenCaptureKit can capture system audio, but it asks for Screen
      Recording permission, which is an alarming prompt to hand a colleague when
      all we want is sound.
    - AudioHardwareCreateProcessTap (macOS 14.4+) captures exactly one process's
      output, asks only for audio access, needs no driver, and leaves the user
      still hearing the audio normally. That is the whole list of things we
      wanted.

  Output contract, so the supervisor never has to guess:
    stderr gets one line before any audio flows:
        FORMAT f32le <sampleRate> <channels>
    stdout gets raw interleaved little-endian float32 from that point on.

  Usage:
    bcc-audiotap --list
    bcc-audiotap --app "Google Chrome"
    bcc-audiotap --pid 4711
    bcc-audiotap --system
*/

import Foundation
import CoreAudio
import AudioToolbox
import AppKit

// MARK: - small helpers

func note(_ s: String) {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

func die(_ s: String) -> Never {
  note("bcc-audiotap: " + s)
  exit(1)
}

/* OSStatus codes are four-char codes as often as they are numbers, and reading
   'who?' beats reading 2003332927 when something goes wrong at 2am. */
func fourCC(_ code: OSStatus) -> String {
  let n = UInt32(bitPattern: code)
  let bytes = [UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff),
               UInt8((n >> 8) & 0xff), UInt8(n & 0xff)]
  let printable = bytes.allSatisfy { $0 >= 0x20 && $0 < 0x7f }
  if printable, let s = String(bytes: bytes, encoding: .ascii) { return "'" + s + "'" }
  return String(code)
}

func check(_ status: OSStatus, _ what: String) {
  if status != noErr { die(what + " failed: " + fourCC(status)) }
}

// MARK: - process discovery

struct Target {
  let name: String
  let pid: pid_t
}

func runningAudioCandidates() -> [Target] {
  NSWorkspace.shared.runningApplications.compactMap { app -> Target? in
    guard let name = app.localizedName else { return nil }
    return Target(name: name, pid: app.processIdentifier)
  }.sorted { $0.name.lowercased() < $1.name.lowercased() }
}

/* Core Audio does not speak pids. Every process that has touched audio has a
   corresponding AudioObjectID, and this is the only way from one to the other.
   A nil here usually means the process is running but has never opened an audio
   stream, so the fix is to play something first. */
func audioObject(forPID pid: pid_t) -> AudioObjectID? {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var input = pid
  var out = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let st = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &addr,
    UInt32(MemoryLayout<pid_t>.size), &input, &size, &out)
  if st != noErr || out == AudioObjectID(kAudioObjectUnknown) { return nil }
  return out
}

// MARK: - argument parsing

var wantList = false
var wantSystem = false
var appName: String? = nil
var explicitPID: pid_t? = nil

let argv = Array(CommandLine.arguments.dropFirst())
var argIndex = 0
while argIndex < argv.count {
  switch argv[argIndex] {
  case "--list":   wantList = true
  case "--system": wantSystem = true
  case "--app":
    argIndex += 1
    if argIndex >= argv.count { die("--app needs an application name") }
    appName = argv[argIndex]
  case "--pid":
    argIndex += 1
    if argIndex >= argv.count { die("--pid needs a process id") }
    guard let p = Int32(argv[argIndex]) else { die("--pid must be a number") }
    explicitPID = p
  case "-h", "--help":
    note("usage: bcc-audiotap [--list | --system | --app <name> | --pid <n>]")
    exit(0)
  default:
    die("unknown argument \(argv[argIndex])")
  }
  argIndex += 1
}

if wantList {
  note("running applications (audio object shown where one exists):")
  for t in runningAudioCandidates() {
    let obj = audioObject(forPID: t.pid)
    let mark = obj != nil ? "  audio=\(obj!)" : ""
    note(String(format: "  pid %6d  %@%@", t.pid, t.name, mark))
  }
  exit(0)
}

// MARK: - resolve what we are tapping

var targetObjects: [AudioObjectID] = []
var targetLabel = "entire system"

if !wantSystem {
  let pid: pid_t
  if let p = explicitPID {
    pid = p
    targetLabel = "pid \(p)"
  } else if let want = appName {
    /* Browsers do not play audio from the process you think they do. Chrome
       renders a tab's sound in a helper process, Safari in "Safari Graphics and
       Media", Firefox in a content process. Tapping only the main process gets
       you a clean, well-formed stream of pure silence.

       So a name match takes the whole family: the app and every helper whose
       name starts with it. They mix down into one tap, which is what we wanted
       anyway since we are listening to a single scanner feed. */
    let family = runningAudioCandidates().filter {
      $0.name.localizedCaseInsensitiveCompare(want) == .orderedSame
        || $0.name.lowercased().hasPrefix(want.lowercased())
        || $0.name.localizedCaseInsensitiveContains(want)
    }
    if family.isEmpty { die("no running application matches \"\(want)\". Try --list.") }

    let objects = family.compactMap { t -> (Target, AudioObjectID)? in
      guard let o = audioObject(forPID: t.pid) else { return nil }
      return (t, o)
    }
    if objects.isEmpty {
      die("\"\(want)\" is running but nothing in it has opened audio yet. "
        + "Start the feed playing, then retry.")
    }
    targetObjects = objects.map { $0.1 }
    targetLabel = "\(objects.count) process"
      + (objects.count == 1 ? "" : "es")
      + " matching \"\(want)\" ["
      + objects.map { "\($0.0.name):\($0.0.pid)" }.joined(separator: ", ") + "]"
    pid = objects[0].0.pid
    _ = pid
  } else {
    die("nothing to tap. Pass --app, --pid or --system. Try --list.")
  }

  if targetObjects.isEmpty {
    guard let obj = audioObject(forPID: pid) else {
      die("\(targetLabel) has no audio object yet. Start playing audio in it, then retry.")
    }
    targetObjects = [obj]
  }
}

// MARK: - create the tap

/* Mono mixdown because scanner audio is mono at the source and Whisper wants
   mono anyway, so mixing here saves a conversion downstream.
   Unmuted because Matt needs to keep hearing the feed while we record it. A
   muted tap silences the browser tab, which would be a memorable bug. */
let tapDescription: CATapDescription = wantSystem
  ? CATapDescription(monoGlobalTapButExcludeProcesses: [])
  : CATapDescription(monoMixdownOfProcesses: targetObjects)

tapDescription.uuid = UUID()
tapDescription.muteBehavior = .unmuted
tapDescription.isPrivate = true
tapDescription.isExclusive = false
tapDescription.name = "BCC scanner tap"

var tapID = AudioObjectID(kAudioObjectUnknown)
let tapStatus = AudioHardwareCreateProcessTap(tapDescription, &tapID)
if tapStatus != noErr {
  /* The most likely failure by a wide margin, and the raw code tells a user
     nothing about what to do next. */
  note("bcc-audiotap: could not create the tap (\(fourCC(tapStatus))).")
  note("  On a first run macOS has to grant audio recording access.")
  note("  Open System Settings > Privacy & Security > Microphone, confirm this")
  note("  tool is listed and enabled, then run it again.")
  exit(1)
}

// MARK: - the tap's native format

var formatAddr = AudioObjectPropertyAddress(
  mSelector: kAudioTapPropertyFormat,
  mScope: kAudioObjectPropertyScopeGlobal,
  mElement: kAudioObjectPropertyElementMain)
var asbd = AudioStreamBasicDescription()
var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
check(AudioObjectGetPropertyData(tapID, &formatAddr, 0, nil, &asbdSize, &asbd),
      "reading the tap's stream format")

let sampleRate = Int(asbd.mSampleRate.rounded())
let channels = Int(asbd.mChannelsPerFrame)
if sampleRate <= 0 || channels <= 0 {
  die("the tap reported a nonsense format (\(sampleRate) Hz, \(channels) ch)")
}

// MARK: - aggregate device that carries the tap

let aggregateUID = UUID().uuidString
let aggregateDescription: [String: Any] = [
  kAudioAggregateDeviceNameKey: "BCC Scanner Tap",
  kAudioAggregateDeviceUIDKey: aggregateUID,
  /* Private keeps this out of Sound preferences and out of every other app's
     device picker. Nobody should ever see this device but us. */
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [] as [Any],
  kAudioAggregateDeviceTapListKey: [
    [
      kAudioSubTapUIDKey: tapDescription.uuid.uuidString,
      kAudioSubTapDriftCompensationKey: true,
    ]
  ],
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID),
      "creating the aggregate device")

// MARK: - pump

/* The IO block runs on a realtime thread, so it does the least possible work:
   copy the bytes and leave. Writing to stdout from inside it would block that
   thread on a pipe, and a blocked realtime audio thread produces dropouts and
   eventually gets the IOProc killed outright. So the block appends to a buffer
   and a plain background thread does the writing.

   A lock in a realtime callback carries its own risk, but at one mono channel
   of 48 kHz float the critical section is a memcpy of a few hundred bytes and
   the drain thread holds the lock for microseconds. A lock-free ring buffer is
   more code for a margin we do not need here. */
let pendingLock = NSLock()
var pending = Data()
var droppedBytes = 0

/* If the consumer downstream stalls we would rather throw away old audio than
   grow without bound. Two seconds of float32 mono at 48 kHz is under 400 KB. */
let maxPending = sampleRate * channels * 4 * 2

var ioProcID: AudioDeviceIOProcID?
let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) {
  _, inInputData, _, _, _ in
  let list = UnsafeMutableAudioBufferListPointer(
    UnsafeMutablePointer(mutating: inInputData))
  guard let first = list.first, let raw = first.mData else { return }
  let bytes = Int(first.mDataByteSize)
  if bytes <= 0 { return }

  pendingLock.lock()
  if pending.count + bytes > maxPending {
    let overflow = pending.count + bytes - maxPending
    pending.removeFirst(min(overflow, pending.count))
    droppedBytes += overflow
  }
  pending.append(raw.assumingMemoryBound(to: UInt8.self), count: bytes)
  pendingLock.unlock()
}
check(ioStatus, "installing the IO block")

// MARK: - teardown, defined before we start so no path can leak a device

var tornDown = false
let teardownLock = NSLock()

func teardown() {
  teardownLock.lock()
  defer { teardownLock.unlock() }
  if tornDown { return }
  tornDown = true
  if let proc = ioProcID {
    AudioDeviceStop(aggregateID, proc)
    AudioDeviceDestroyIOProcID(aggregateID, proc)
  }
  if aggregateID != AudioObjectID(kAudioObjectUnknown) {
    AudioHardwareDestroyAggregateDevice(aggregateID)
  }
  if tapID != AudioObjectID(kAudioObjectUnknown) {
    AudioHardwareDestroyProcessTap(tapID)
  }
}

/* signal(2) handlers cannot safely call most of Core Audio, so these only flip
   the run loop off and let ordinary code clean up on the main thread. The
   sources are held for the life of the process on purpose: releasing them
   cancels delivery. */
var shouldStop = false
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM, SIGHUP] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { shouldStop = true }
  src.resume()
  signalSources.append(src)
}

check(AudioDeviceStart(aggregateID, ioProcID), "starting the device")

note("FORMAT f32le \(sampleRate) \(channels)")
note("bcc-audiotap: tapping \(targetLabel) at \(sampleRate) Hz, \(channels) ch")

/* Drain thread. Blocking writes here are correct: if the downstream consumer
   backs up, this thread parks and the IO block keeps trimming the oldest audio,
   which is what we want for a live feed. */
let stdoutHandle = FileHandle.standardOutput
let drain = Thread {
  while true {
    pendingLock.lock()
    let chunk = pending
    pending.removeAll(keepingCapacity: true)
    pendingLock.unlock()

    if chunk.isEmpty {
      if shouldStop { break }
      usleep(5000)
      continue
    }
    do {
      try stdoutHandle.write(contentsOf: chunk)
    } catch {
      /* Consumer closed the pipe. Normal shutdown, not an error. */
      shouldStop = true
      break
    }
  }
}
drain.stackSize = 512 * 1024
drain.start()

while !shouldStop {
  RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.25))
}

teardown()
if droppedBytes > 0 {
  note("bcc-audiotap: dropped \(droppedBytes) bytes to keep the buffer bounded")
}
note("bcc-audiotap: stopped")
exit(0)
