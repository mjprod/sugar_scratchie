import Foundation

/// Vite `@vitejs/plugin-basic-ssl` certs are not trusted by iOS. Debug media
/// fetches (and video cache downloads) use this trust-all session.
enum DevMediaClient {
    static let shared: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        return URLSession(configuration: config, delegate: TrustAllDelegate.shared, delegateQueue: nil)
    }()

    private final class TrustAllDelegate: NSObject, URLSessionDelegate {
        static let shared = TrustAllDelegate()

        func urlSession(
            _ session: URLSession,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            if let trust = challenge.protectionSpace.serverTrust {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                completionHandler(.performDefaultHandling, nil)
            }
        }
    }
}
