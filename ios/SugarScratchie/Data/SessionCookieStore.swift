import Foundation

/// Persists the player session cookie (`sugar_session`) across launches.
/// Auth is cookie-only — there is no Bearer token.
final class SessionCookieStore: @unchecked Sendable {
    static let sessionCookie = "sugar_session"

    private let defaults = UserDefaults.standard
    private let lock = NSLock()
    private var memory: [String: HTTPCookie] = [:]

    private enum Keys {
        static let name = "sugar_session_name"
        static let value = "sugar_session_value"
        static let domain = "sugar_session_domain"
        static let path = "sugar_session_path"
        static let secure = "sugar_session_secure"
        static let expires = "sugar_session_expires"
    }

    init() {
        guard
            let name = defaults.string(forKey: Keys.name),
            let value = defaults.string(forKey: Keys.value),
            let domain = defaults.string(forKey: Keys.domain),
            !name.isEmpty, !value.isEmpty, !domain.isEmpty
        else { return }
        let path = defaults.string(forKey: Keys.path) ?? "/"
        let secure = defaults.bool(forKey: Keys.secure)
        let expires = defaults.object(forKey: Keys.expires) as? Date
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
        ]
        if secure { props[.secure] = "TRUE" }
        if let expires { props[.expires] = expires }
        if let cookie = HTTPCookie(properties: props) {
            memory[name] = cookie
            HTTPCookieStorage.shared.setCookie(cookie)
        }
    }

    func cookies(for url: URL) -> [HTTPCookie] {
        lock.lock()
        defer { lock.unlock() }
        let now = Date()
        return memory.values.filter { cookie in
            if let expires = cookie.expiresDate, expires < now { return false }
            guard let host = url.host else { return false }
            if cookie.domain == host { return true }
            if cookie.domain.hasPrefix(".") {
                let base = String(cookie.domain.dropFirst())
                if host.hasSuffix(cookie.domain) || host == base { return true }
            }
            return host.hasSuffix(cookie.domain)
        }
    }

    func store(cookies: [HTTPCookie], for url: URL) {
        lock.lock()
        defer { lock.unlock() }
        for cookie in cookies where cookie.name == Self.sessionCookie {
            let expired = (cookie.expiresDate.map { $0 < Date() } ?? false) || cookie.value.isEmpty
            if expired {
                clearLocked()
                continue
            }
            memory[cookie.name] = cookie
            HTTPCookieStorage.shared.setCookie(cookie)
            defaults.set(cookie.name, forKey: Keys.name)
            defaults.set(cookie.value, forKey: Keys.value)
            defaults.set(cookie.domain, forKey: Keys.domain)
            defaults.set(cookie.path, forKey: Keys.path)
            defaults.set(cookie.isSecure, forKey: Keys.secure)
            if let expires = cookie.expiresDate {
                defaults.set(expires, forKey: Keys.expires)
            } else {
                defaults.removeObject(forKey: Keys.expires)
            }
        }
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        clearLocked()
    }

    private func clearLocked() {
        memory.removeAll()
        defaults.removeObject(forKey: Keys.name)
        defaults.removeObject(forKey: Keys.value)
        defaults.removeObject(forKey: Keys.domain)
        defaults.removeObject(forKey: Keys.path)
        defaults.removeObject(forKey: Keys.secure)
        defaults.removeObject(forKey: Keys.expires)
        if let cookies = HTTPCookieStorage.shared.cookies {
            for cookie in cookies where cookie.name == Self.sessionCookie {
                HTTPCookieStorage.shared.deleteCookie(cookie)
            }
        }
    }

    func apply(to request: inout URLRequest) {
        guard let url = request.url else { return }
        let cookies = cookies(for: url)
        guard !cookies.isEmpty else { return }
        let header = HTTPCookie.requestHeaderFields(with: cookies)
        for (key, value) in header {
            request.setValue(value, forHTTPHeaderField: key)
        }
    }

    func capture(from response: URLResponse) {
        guard let http = response as? HTTPURLResponse, let url = http.url else { return }
        let headerFields = http.allHeaderFields.reduce(into: [String: String]()) { result, pair in
            if let key = pair.key as? String, let value = pair.value as? String {
                result[key] = value
            }
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headerFields, for: url)
        store(cookies: cookies, for: url)
    }
}
