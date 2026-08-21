// API.swift
//
// One door to the server, the same way web/lib/llm.js is one door to the
// models. Everything here is a GET or a POST against the routes the dashboard
// already polls, behind the same Basic credential, so the app adds no new
// surface to the deployment: if the site is up, the app works, and the login
// that opens one opens the other.
//
// The credential lives in the Keychain and nowhere else. It is never logged,
// never put in a URL, and sent to exactly one host: the one the person typed
// into settings.

import Foundation
import Security

// MARK: - Settings + Keychain

final class Settings: ObservableObject {
    static let shared = Settings()

    @Published var server: String
    @Published var username: String
    @Published var password: String

    /* Signed in means "we have something to send", not "the server liked it".
       The first request answers the second question, and a 401 routes back to
       the login sheet with the reason on it. */
    var configured: Bool { !server.isEmpty && !username.isEmpty && !password.isEmpty }

    private init() {
        let d = UserDefaults.standard
        server = d.string(forKey: "bcc.server") ?? "https://www.scan.boston"
        username = d.string(forKey: "bcc.user") ?? ""
        password = Keychain.read("bcc.password") ?? ""
    }

    func save() {
        let d = UserDefaults.standard
        server = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if server.hasSuffix("/") { server = String(server.dropLast()) }
        if !server.isEmpty && !server.contains("://") { server = "https://" + server }
        d.set(server, forKey: "bcc.server")
        d.set(username, forKey: "bcc.user")
        Keychain.write("bcc.password", password)
    }

    var authHeader: String? {
        guard configured else { return nil }
        let raw = "\(username):\(password)"
        guard let data = raw.data(using: .utf8) else { return nil }
        return "Basic " + data.base64EncodedString()
    }
}

enum Keychain {
    static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}

// MARK: - The client

enum APIError: LocalizedError {
    case notConfigured
    case unauthorized
    case http(Int, String)
    case decode(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Add the server and login in Settings first."
        case .unauthorized: return "The server refused the login. Check the username and password in Settings."
        case .http(let c, let path): return "\(path) answered \(c)."
        case .decode(let path): return "\(path) sent a shape this build does not know. Update the app."
        case .transport(let s): return s
        }
    }
}

enum API {
    /* One session, cookies off, short timeouts. Every read the dashboard
       makes finishes in a second or two; the archive and the ask are the
       slow ones and get their own budget below. */
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    static func request(_ path: String, timeout: TimeInterval = 30) throws -> URLRequest {
        let s = Settings.shared
        guard let auth = s.authHeader, let url = URL(string: s.server + path) else {
            throw APIError.notConfigured
        }
        var r = URLRequest(url: url)
        r.timeoutInterval = timeout
        r.setValue(auth, forHTTPHeaderField: "Authorization")
        r.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        return r
    }

    static func get<T: Decodable>(_ path: String, as type: T.Type, timeout: TimeInterval = 30) async throws -> T {
        let (data, resp) = try await session.data(for: request(path, timeout: timeout))
        try check(resp, path)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.decode(path) }
    }

    /* The board lists have shipped as bare arrays and as wrapped objects
       ({situations:[...]}), and the dashboard accepts both, so this does too.
       Elements decode individually; a row this build has never seen drops
       out instead of taking the whole board with it. */
    struct ListEnvelope<T: Decodable>: Decodable {
        var incidents: [Lossy<T>]?
        var situations: [Lossy<T>]?
        var transcripts: [Lossy<T>]?
        var items: [Lossy<T>]?
        var results: [Lossy<T>]?
        var list: [[Lossy<T>]?] { [incidents, situations, transcripts, items, results] }
    }

    static func getList<T: Decodable>(_ path: String, as type: T.Type, timeout: TimeInterval = 30) async throws -> [T] {
        let (data, resp) = try await session.data(for: request(path, timeout: timeout))
        try check(resp, path)
        let dec = JSONDecoder()
        if let arr = try? dec.decode([Lossy<T>].self, from: data) {
            return arr.compactMap { $0.value }
        }
        if let env = try? dec.decode(ListEnvelope<T>.self, from: data),
           let arr = env.list.compactMap({ $0 }).first {
            return arr.compactMap { $0.value }
        }
        throw APIError.decode(path)
    }

    static func post<T: Decodable>(_ path: String, body: [String: String], as type: T.Type, timeout: TimeInterval = 120) async throws -> T {
        var r = try request(path, timeout: timeout)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: r)
        try check(resp, path)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.decode(path) }
    }

    private static func check(_ resp: URLResponse, _ path: String) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        if http.statusCode == 401 || http.statusCode == 429 { throw APIError.unauthorized }
        guard (200...299).contains(http.statusCode) else { throw APIError.http(http.statusCode, path) }
    }

    // The reads, named for what they answer.
    static func incidents() async throws -> [Incident] { try await getList("/incidents.json", as: Incident.self) }
    static func situations() async throws -> [Situation] { try await getList("/situations.json", as: Situation.self) }
    static func transcripts() async throws -> [Transcript] { try await getList("/transcripts.json", as: Transcript.self) }
    static func pipeline() async throws -> Pipeline { try await get("/pipeline.json", as: Pipeline.self) }
    static func shift() async throws -> ShiftBriefing { try await get("/shift-change.json", as: ShiftBriefing.self, timeout: 90) }
    /* .urlQueryAllowed leaves & + = ? # alone, which are exactly the bytes
       that break a query param. Encode everything but the unreserved set. */
    static let queryValueAllowed: CharacterSet = {
        var s = CharacterSet.alphanumerics
        s.insert(charactersIn: "-._~")
        return s
    }()

    static func search(_ q: String) async throws -> ArchiveAnswer {
        let enc = q.addingPercentEncoding(withAllowedCharacters: queryValueAllowed) ?? q
        return try await get("/api/vault-search?q=" + enc, as: ArchiveAnswer.self, timeout: 90)
    }
    static func deskRead(minutes: Int) async throws -> DeskRead {
        try await get("/api/desk-read?minutes=\(minutes)", as: DeskRead.self, timeout: 60)
    }
    static func ask(_ q: String) async throws -> DeskAnswer {
        try await post("/api/desk-ask", body: ["q": q], as: DeskAnswer.self, timeout: 150)
    }
}
