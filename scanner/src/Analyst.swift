// src/Analyst.swift
//
// The desk editor, running where the radio already is.
//
// Situations are the top of the newsroom board: the cards that say "working
// fire in Back Bay" rather than listing four hundred transmissions. A model
// reads the recent stream and groups it into stories, and for a while that
// model ran in a Node script under launchd on somebody's laptop, because that
// is where the tooling happened to be pointed the night it was written.
//
// That was the wrong machine and the wrong process. A laptop sleeps, gets
// closed, and gets its disk cleaned out; one `ollama rm` during a tidy-up
// took the model away and the newsroom's headline layer went dark for four
// hours with nothing in the app to say so. Meanwhile the relay was running
// perfectly on the Mac it belongs on, already talking to Ollama, already
// holding the dashboard's address and token, already showing a log somebody
// looks at.
//
// So it lives here now. One app, one machine, one thing to keep alive, and
// when it fails it says so in the same window as everything else.
//
// The division of labour is deliberate and unchanged: this proposes, the
// server disposes. The dashboard hands over the prompt, the schema and the
// exact text to judge; the model answers; the server re-runs every guardrail
// (geocoding, feed verification, clip matching, threading, id discipline)
// before anything reaches the board. A local model that could write the
// newsroom wall directly would be a trust hole, so it cannot.

import Foundation

final class Analyst {
    /* Long enough that a quiet night is not a stream of pointless work, short
       enough that a story appears while it is still a story. The server skips
       the model entirely when the transcript has not changed, so most cycles
       cost one small GET. */
    private static let interval: TimeInterval = 75

    private let lock = NSLock()
    private var stopping = false
    private var thread: Thread?

    private var endpoint = ""
    private var token = ""
    private var machine = ""
    private var model = ""

    /// One line per cycle, into the same log as the feeds.
    var onLog: ((String) -> Void)?

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 0     // the model call is the slow part
        return URLSession(configuration: cfg)
    }()
}
