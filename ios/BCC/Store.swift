// Store.swift
//
// The app's copy of the board, refreshed the way the dashboard refreshes:
// poll while somebody is looking, stop when they are not. Each tab drives its
// own load through this one object so two tabs never race two copies of the
// same key, and a failed poll keeps the last good board on screen with the
// failure in a corner rather than blanking a screen somebody is reading.

import Foundation
import Combine

@MainActor
final class Board: ObservableObject {
    static let shared = Board()

    @Published var incidents: [Incident] = []
    @Published var situations: [Situation] = []
    @Published var transcripts: [Transcript] = []
    @Published var feedsOffline: Int = 0
    @Published var feedsTotal: Int = 0
    @Published var feedList: [FeedHealth] = []
    @Published var lastFetch: Date?
    @Published var problem: String?          // the last poll's failure, or nil
    @Published var needsLogin: Bool = false

    private var polling = 0

    /* Views call this in .task; the loop dies with the view. Several views
       polling at once collapse to one fetch cadence via the counter. */
    func poll() async {
        polling += 1
        defer { polling -= 1 }
        while !Task.isCancelled {
            if polling == 1 || lastFetch == nil || Date().timeIntervalSince(lastFetch ?? .distantPast) > 3 {
                await refresh()
            }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
        }
    }

    /* Run one read to a Result, so four can run together and settle alone. */
    private nonisolated static func grab<T>(_ op: @Sendable () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await op()) } catch { return .failure(error) }
    }
    private static func failed<T>(_ r: Result<T, Error>) -> Error? {
        if case .failure(let e) = r { return e }
        return nil
    }

    func refresh() async {
        guard Settings.shared.configured else { needsLogin = true; return }
        /* Each read succeeds or fails alone. One route serving a shape this
           build does not know must cost that one panel, not the whole board;
           the day that rule was broken the map said 0 ACTIVE over a city that
           was not quiet. */
        async let incR = Self.grab { try await API.incidents() }
        async let sitR = Self.grab { try await API.situations() }
        async let txR = Self.grab { try await API.transcripts() }
        async let pipeR = Self.grab { try await API.pipeline() }
        let (i, s, t, p) = await (incR, sitR, txR, pipeR)

        if case .success(let v) = i { incidents = v }
        if case .success(let v) = s { situations = v }
        if case .success(let v) = t { transcripts = v }
        if case .success(let v) = p {
            let feeds = v.feeds ?? []
            feedsTotal = feeds.count
            feedsOffline = feeds.filter { ($0.status ?? "") == "offline" || ($0.status ?? "") == "off" }.count
            feedList = feeds
        }

        let failures = [Self.failed(i), Self.failed(s), Self.failed(t), Self.failed(p)].compactMap { $0 }
        needsLogin = failures.contains { e in
            if let api = e as? APIError, case .unauthorized = api { return true }
            return false
        }
        problem = failures.first?.localizedDescription
        if failures.count < 4 { lastFetch = Date() }
    }

    var scannerActive: [Incident] { incidents.filter { $0.isActive } }
}
