// Sent Tweaks iOS license client — integrate into your own iOS app project.
// iOS 15+; import ios-public-pkcs1.pem into the Xcode app target.
// IMPORTANT: /api/ios/status is a website-only status indicator.
// The app MUST use claim()/verify() and verify the RSA signature before granting access.
import Foundation
import Security
import CryptoKit

@available(iOS 15.0, *)
final class SentIOSAuth {
    enum AuthError: Error {
        case keychain(OSStatus)
        case invalidPublicKey
        case invalidResponse
        case rejected(String)
        case signatureInvalid
        case licenseExpired
        case serverTimeInvalid
    }

    struct License: Decodable {
        let key: String
        let product: String
        let status: String
        let planHours: Int
        let expiresAtMs: Int64
    }
    struct AuthProof: Decodable {
        let protocolVersion: Int
        let algorithm: String
        let action: String
        let nonce: String
        let deviceDigest: String
        let serverTimeMs: Int64
        let signature: String
    }
    struct Reply: Decodable {
        let ok: Bool
        let valid: Bool
        let data: License
        let auth: AuthProof
    }
    struct ServerError: Decodable {
        let error: String?
    }

    private let baseURL: URL
    private let publicKey: SecKey
    private let session: URLSession

    init(baseURL: URL, publicKey: SecKey, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.publicKey = publicKey
        self.session = session
    }

    /// PKCS#1 PEM: `-----BEGIN RSA PUBLIC KEY-----`.
    static func loadPKCS1PublicKey(resource: String = "ios-public-pkcs1") throws -> SecKey {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "pem"),
              let contents = try? String(contentsOf: url, encoding: .utf8) else {
            throw AuthError.invalidPublicKey
        }
        let encoded = contents.components(separatedBy: .newlines)
            .filter { !$0.hasPrefix("-----") }
            .joined()
        guard let der = Data(base64Encoded: encoded) else { throw AuthError.invalidPublicKey }
        let params: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits as String: 3072
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(der as CFData, params as CFDictionary, &error) else {
            throw AuthError.invalidPublicKey
        }
        return key
    }

    /// A random installation ID, stored as a non-migrating Keychain item.
    /// This binds a key to one *stored ID*, not irrefutably to physical hardware.
    private static func installationID() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "sent.tweaks.ios.license",
            kSecAttrAccount as String: "installation-id",
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let found = SecItemCopyMatching(query as CFDictionary, &result)
        if found == errSecSuccess {
            guard let data = result as? Data,
                  let id = String(data: data, encoding: .utf8) else {
                throw AuthError.invalidResponse
            }
            return id
        }
        guard found == errSecItemNotFound else { throw AuthError.keychain(found) }
        let id = UUID().uuidString.lowercased()
        var entry = query
        entry.removeValue(forKey: kSecReturnData as String)
        entry.removeValue(forKey: kSecMatchLimit as String)
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        entry[kSecValueData as String] = Data(id.utf8)
        let added = SecItemAdd(entry as CFDictionary, nil)
        if added == errSecDuplicateItem { return try installationID() }
        guard added == errSecSuccess else { throw AuthError.keychain(added) }
        return id
    }

    private static func newNonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw AuthError.keychain(status) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func signatureData(_ value: String) -> Data? {
        let value = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = value + String(repeating: "=", count: (4 - value.count % 4) % 4)
        return Data(base64Encoded: padded)
    }

    /// Activates first use, permanently binds key to this installation ID.
    func claim(key: String) async throws -> License {
        try await authenticate(key: key, action: "claim")
    }

    /// Rechecks server-side revocation, binding and expiry; requires network.
    func verify(key: String) async throws -> License {
        try await authenticate(key: key, action: "verify")
    }

    private func authenticate(key: String, action: String) async throws -> License {
        let normalizedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let deviceID = try Self.installationID()
        let nonce = try Self.newNonce()
        let url = baseURL.appendingPathComponent("api")
            .appendingPathComponent("ios")
            .appendingPathComponent(action)
        guard url.scheme == "https" else { throw AuthError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "key": normalizedKey,
            "deviceId": deviceID,
            "nonce": nonce
        ])

        let (payload, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse else { throw AuthError.invalidResponse }
        guard (200...299).contains(response.statusCode) else {
            let body = try? JSONDecoder().decode(ServerError.self, from: payload)
            throw AuthError.rejected(body?.error ?? "HTTP_\(response.statusCode)")
        }
        let body = try JSONDecoder().decode(Reply.self, from: payload)
        let license = body.data
        let proof = body.auth
        guard body.ok, body.valid,
              proof.protocolVersion == 1,
              proof.algorithm == "RSASSA-PKCS1-v1_5-SHA256",
              proof.action == action,
              proof.nonce == nonce,
              proof.deviceDigest == Self.sha256Hex(deviceID),
              license.key == normalizedKey,
              license.product == "ios",
              license.status == "active",
              license.planHours == 24 else { throw AuthError.invalidResponse }

        let signed = [
            "SENT-IOS-AUTH-V1",
            "action=\(action)",
            "nonce=\(nonce)",
            "key=\(normalizedKey)",
            "deviceDigest=\(proof.deviceDigest)",
            "expiresAtMs=\(license.expiresAtMs)",
            "serverTimeMs=\(proof.serverTimeMs)",
            "product=ios",
            "valid=1"
        ].joined(separator: "\n")
        guard let signature = Self.signatureData(proof.signature) else {
            throw AuthError.signatureInvalid
        }
        var verifyError: Unmanaged<CFError>?
        let verified = SecKeyVerifySignature(
            publicKey, .rsaSignatureMessagePKCS1v15SHA256,
            Data(signed.utf8) as CFData, signature as CFData, &verifyError
        )
        guard verified else { throw AuthError.signatureInvalid }
        let deviceNowMs = Int64(Date().timeIntervalSince1970 * 1000)
        guard abs(deviceNowMs - proof.serverTimeMs) <= 600_000 else {
            throw AuthError.serverTimeInvalid
        }
        guard license.expiresAtMs > proof.serverTimeMs else {
            throw AuthError.licenseExpired
        }
        return license
    }
}

// Example (inside the iOS app):
// let key = try SentIOSAuth.loadPKCS1PublicKey()
// let auth = SentIOSAuth(baseURL: URL(string: "https://YOUR-IOS-WORKER.workers.dev")!, publicKey: key)
// let license = try await auth.claim(key: userEnteredKey)
// // At every protected entry / on a regular interval, call:
// let checked = try await auth.verify(key: userEnteredKey)
// // Only grant access after these functions return successfully.
