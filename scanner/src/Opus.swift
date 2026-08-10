// src/Opus.swift
//
// A decoder for the Opus packets the RapidSOS radio socket sends.
//
// Why libopus rather than something already on the Mac: AudioToolbox will
// decode plenty of formats, but what arrives here is a bare Opus packet with
// no container around it, and the system decoders want a container. libopus
// takes a raw packet, which is exactly what we hold, and it is the reference
// implementation of the format, so it is the one thing in this path that will
// not surprise anybody at 3am. It is also about 300KB and build.sh already
// absorbs dylib dependencies into the bundle, so shipping it costs nothing a
// person has to install.
//
// One decoder per connection, never shared between threads. Opus decoders
// carry the state of the stream they are decoding: hand the same one two
// feeds and both come out as gravel.

import Foundation
import COpus

final class OpusDecoder {
    /* The radio is 16kHz mono, which is also exactly what Whisper wants, so
       nothing in this path ever resamples. That is a happy accident of the
       feed's design and worth keeping: every resample is a small loss on
       audio that is already clipped and noisy. */
    static let rate: Int32 = 16_000
    static let channels: Int32 = 1

    /* 120ms at 48kHz, the largest frame Opus can legally produce. The packets
       here are 20ms, but sizing the scratch buffer to the format's maximum
       rather than to what we have seen means a longer packet is decoded
       instead of overrunning us. */
    private static let maxSamples = 5760

    private var dec: OpaquePointer?
    private var scratch = [Int16](repeating: 0, count: OpusDecoder.maxSamples)

    init?() {
        var err: Int32 = 0
        dec = opus_decoder_create(OpusDecoder.rate, OpusDecoder.channels, &err)
        if err != OPUS_OK || dec == nil { return nil }
    }

    deinit { if let d = dec { opus_decoder_destroy(d) } }

    /* One packet in, PCM out. A packet that will not decode returns nil rather
       than throwing: a corrupt frame on a live radio feed is a fact of life,
       and the right response is to drop it and keep listening, not to tear
       down a socket that is otherwise healthy. */
    func decode(_ packet: Data) -> [Int16]? {
        guard let d = dec, !packet.isEmpty else { return nil }
        let n: Int32 = packet.withUnsafeBytes { raw in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return -1 }
            return scratch.withUnsafeMutableBufferPointer { out -> Int32 in
                guard let dst = out.baseAddress else { return -1 }
                return opus_decode(d, base, Int32(packet.count), dst,
                                   Int32(OpusDecoder.maxSamples), 0)
            }
        }
        guard n > 0 else { return nil }
        return Array(scratch[0..<Int(n)])
    }
}
