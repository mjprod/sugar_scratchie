import Foundation

final class SugarAPI: @unchecked Sendable {
    private let cookieStore: SessionCookieStore
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let apiSession: URLSession

    init(cookieStore: SessionCookieStore) {
        self.cookieStore = cookieStore
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 20
        config.waitsForConnectivity = false
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        self.apiSession = URLSession(configuration: config)
    }

    private var apiBaseUrl: String { DevEndpoints.apiBaseUrl }
    private var mediaBaseUrl: String { DevEndpoints.mediaBaseUrl }

    func mediaUrl(_ path: String) -> String {
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return path }
        var cleaned = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("public/") {
            cleaned = String(cleaned.dropFirst("public/".count))
        }
        if !cleaned.hasPrefix("/") {
            cleaned = "/" + cleaned
        }
        let encoded = cleaned
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { segment -> String in
                if segment.isEmpty { return "" }
                return segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(segment)
            }
            .joined(separator: "/")
        return mediaBaseUrl + encoded
    }

    func backgroundUrl(_ card: CardInfo) -> String? {
        guard !card.background.isEmpty else { return nil }
        return mediaUrl(card.background)
    }

    func foregroundUrl(_ card: CardInfo) -> String? {
        guard !card.foreground.isEmpty else { return nil }
        return mediaUrl(card.foreground)
    }

    func login(email: String, password: String) async throws -> AuthResponse {
        try await postJSON("/api/auth/login", body: CredentialsBody(email: email, password: password))
    }

    func register(email: String, password: String) async throws -> AuthResponse {
        try await postJSON("/api/auth/register", body: CredentialsBody(email: email, password: password))
    }

    func logout() async {
        defer { cookieStore.clear() }
        do {
            var request = URLRequest(url: URL(string: "\(apiBaseUrl)/api/auth/logout")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
            cookieStore.apply(to: &request)
            let (_, response) = try await apiSession.data(for: request)
            cookieStore.capture(from: response)
        } catch {
            // ignore — cookie cleared in defer
        }
    }

    func session() async throws -> SessionResponse {
        try await get("/api/auth/session")
    }

    func wallet() async throws -> WalletResponse {
        try await get("/api/me/wallet")
    }

    func cards() async throws -> CardsResponse {
        try await get("/api/cards")
    }

    func startScratchHand(cardId: String) async throws -> ScratchHandResponse {
        try await postJSON("/api/rewards/scratch/hands", body: ScratchHandRequest(cardId: cardId))
    }

    func claimScratchCoins(handId: String, milestone: Int, cardId: String) async throws -> ScratchCoinsResponse {
        try await postJSON(
            "/api/rewards/scratch/coins",
            body: ScratchCoinsRequest(handId: handId, milestone: milestone, cardId: cardId)
        )
    }

    func fetchBytes(_ urlString: String) async throws -> Data {
        guard let url = URL(string: urlString) else {
            throw ApiException(statusCode: 400, message: "Bad URL")
        }
        let (data, response) = try await DevMediaClient.shared.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw ApiException(statusCode: 0, message: "No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ApiException(statusCode: http.statusCode, message: "HTTP \(http.statusCode)")
        }
        return data
    }

    func fetchText(_ urlString: String) async throws -> String {
        let data = try await fetchBytes(urlString)
        return String(decoding: data, as: UTF8.self)
    }

    /// Download remote media to a cached file so AVPlayer can play Vite basic-ssl URLs.
    func cachedMediaFile(urlString: String) async throws -> URL {
        guard let remote = URL(string: urlString) else {
            throw ApiException(statusCode: 400, message: "Bad media URL")
        }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let folder = caches.appendingPathComponent("sugar_media", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = remote.path
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: " ", with: "_")
        let dest = folder.appendingPathComponent(name.isEmpty ? UUID().uuidString : name)
        if FileManager.default.fileExists(atPath: dest.path) {
            return dest
        }
        let data = try await fetchBytes(urlString)
        try data.write(to: dest, options: .atomic)
        return dest
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: URL(string: "\(apiBaseUrl)\(path)")!)
        request.httpMethod = "GET"
        cookieStore.apply(to: &request)
        return try await execute(request)
    }

    private func postJSON<Req: Encodable, Res: Decodable>(_ path: String, body: Req) async throws -> Res {
        var request = URLRequest(url: URL(string: "\(apiBaseUrl)\(path)")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        cookieStore.apply(to: &request)
        return try await execute(request)
    }

    private func execute<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await apiSession.data(for: request)
        cookieStore.capture(from: response)
        guard let http = response as? HTTPURLResponse else {
            throw ApiException(statusCode: 0, message: "No HTTP response")
        }
        if !(200..<300).contains(http.statusCode) {
            throw ApiException(statusCode: http.statusCode, message: parseDetail(data) ?? "HTTP \(http.statusCode)")
        }
        return try decoder.decode(T.self, from: data)
    }

    private func parseDetail(_ data: Data) -> String? {
        if data.isEmpty { return nil }
        if let err = try? decoder.decode(ApiErrorBody.self, from: data),
           let message = err.detail?.message
        {
            return message
        }
        return String(decoding: data.prefix(300), as: UTF8.self)
    }
}

private struct CredentialsBody: Codable {
    var email: String
    var password: String
}
