import Foundation

enum ServerTarget: String, CaseIterable, Identifiable {
    case local
    case remote

    var id: String { rawValue }

    var label: String {
        switch self {
        case .local: return "Local"
        case .remote: return "Remote (.env)"
        }
    }
}

/// Simulator → `127.0.0.1`. Device on Wi‑Fi → LAN host from build script.
/// Remote → values from `frontend-new/.env` `VITE_*_PROXY`.
enum DevEndpoints {
    private static let prefsKey = "server_target_v2"

    private static var current: ServerTarget = {
        if let raw = UserDefaults.standard.string(forKey: prefsKey),
           let value = ServerTarget(rawValue: raw)
        {
            return value
        }
        // Prefer Remote so the app works without local Postgres / API.
        return .remote
    }()

    static var target: ServerTarget {
        get { current }
        set {
            current = newValue
            UserDefaults.standard.set(newValue.rawValue, forKey: prefsKey)
        }
    }

    private static var localHost: String {
        #if targetEnvironment(simulator)
        return "127.0.0.1"
        #else
        return DevConfigGenerated.lanHost
        #endif
    }

    static var apiBaseUrl: String {
        switch current {
        case .local:
            return "http://\(localHost):8090"
        case .remote:
            return DevConfigGenerated.remoteApiBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
    }

    static var mediaBaseUrl: String {
        switch current {
        case .local:
            return "https://\(localHost):5080"
        case .remote:
            return DevConfigGenerated.remoteMediaBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
    }
}
