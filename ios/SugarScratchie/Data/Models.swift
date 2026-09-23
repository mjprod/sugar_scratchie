import Foundation

struct UserPublic: Codable, Equatable, Sendable {
    var id: String
    var email: String
    var provider: String?
    var emailVerified: Bool?
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var genderInterest: String?
    var referralCode: String?
    var welcomeClaimed: Bool?
    var homeTutorialDone: Bool?
    var recommendationStatus: String?
}

struct AuthResponse: Codable, Sendable {
    var ok: Bool?
    var user: UserPublic?
}

struct SessionResponse: Codable, Sendable {
    var authenticated: Bool
    var user: UserPublic?
}

struct WalletResponse: Codable, Equatable, Sendable {
    var diamonds: Int
    var coins: Int

    init(diamonds: Int = 0, coins: Int = 0) {
        self.diamonds = diamonds
        self.coins = coins
    }
}

struct CardsResponse: Codable, Sendable {
    var cards: [CardInfo]
}

struct CardInfo: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var label: String
    var background: String
    var foreground: String
    var mesh: String
    var hasMesh: Bool?
    var modelId: String?
    var themeId: String?
    var trailer: String?

    enum CodingKeys: String, CodingKey {
        case id, label, background, foreground, mesh, trailer
        case hasMesh = "has_mesh"
        case modelId = "model_id"
        case themeId = "theme_id"
    }

    init(
        id: String,
        label: String,
        background: String = "",
        foreground: String = "",
        mesh: String = "",
        hasMesh: Bool? = false,
        modelId: String? = nil,
        themeId: String? = nil,
        trailer: String? = nil
    ) {
        self.id = id
        self.label = label
        self.background = background
        self.foreground = foreground
        self.mesh = mesh
        self.hasMesh = hasMesh
        self.modelId = modelId
        self.themeId = themeId
        self.trailer = trailer
    }
}

struct ScratchHandRequest: Codable, Sendable {
    var cardId: String?
}

struct ScratchHandResponse: Codable, Sendable {
    var handId: String
    var milestonesRemaining: Int?
    var handsRemainingToday: Int?
}

struct ScratchCoinsRequest: Codable, Sendable {
    var handId: String
    var milestone: Int
    var cardId: String?
}

struct ScratchCoinsResponse: Codable, Sendable {
    var ok: Bool?
    var coins: Int?
    var alreadyClaimed: Bool?
    var wallet: WalletResponse?
}

struct ApiErrorBody: Codable, Sendable {
    var detail: AnyCodableDetail?
}

enum AnyCodableDetail: Codable, Sendable {
    case string(String)
    case array([String])
    case other

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let values = try? container.decode([String].self) {
            self = .array(values)
            return
        }
        if let objects = try? container.decode([[String: String]].self) {
            let parts = objects.compactMap { $0["msg"] ?? $0.values.first }
            self = .array(parts)
            return
        }
        self = .other
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .array(let values): try container.encode(values)
        case .other: try container.encodeNil()
        }
    }

    var message: String? {
        switch self {
        case .string(let value): return value
        case .array(let values): return values.joined(separator: "; ")
        case .other: return nil
        }
    }
}

struct ApiException: Error, LocalizedError {
    var statusCode: Int
    var message: String

    var errorDescription: String? { message }
}
