import Foundation
import LocalAuthentication
import Security

/// The phone's device key for each inbox (ADR-028), the iPhone's twin of the device half of Keys.java:
/// ECDSA P-256 made inside the Secure Enclave and never exportable. The inbox holds its public half and
/// checks a signature from it each time the phone pairs or refreshes its token.
///
/// - It needs a passcode: made `WhenPasscodeSetThisDeviceOnly`, so a phone without one makes no key
///   (connecting asks for a passcode first), and removing the passcode deletes it (connect again), as
///   Android's KeyPermanentlyInvalidatedException.
/// - Each use needs the owner (`userPresence`: Face ID or Touch ID, any enrolled, or the passcode; a new
///   face or finger does not end it, as Android's `setInvalidatedByBiometricEnrollment(false)`).
/// - It signs only within five minutes of the owner unlocking the app: the app keeps the context of that
///   unlock for five minutes and signs with it, never asking on its own. Past that, signing fails with
///   `authRequired`; the screens ask once and try again, as on Android. Android's Keystore counts the
///   five minutes itself; here the app does, and the Secure Enclave still refuses any use without an
///   unlock of the owner's behind it.
final class DeviceKeys {
  enum Failure: Error {
    case authRequired, keyGone, noScreenLock
    case other(String)
  }

  static let authValidSeconds: TimeInterval = 300
  private let group: String?
  private let lock = NSLock()
  private var unlock: (context: LAContext, at: Date)?

  init(group: String? = Bundle.main.object(forInfoDictionaryKey: "SDIKeychainAppGroup") as? String) {
    self.group = group
  }

  /// The phone has a passcode: what every key here relies on.
  static func deviceSecure() -> Bool {
    LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
  }

  /// The owner just unlocked the app with this context: the device key may sign with it for five minutes.
  func unlocked(with context: LAContext, at: Date = Date()) {
    context.interactionNotAllowed = true
    lock.lock()
    unlock?.context.invalidate()
    unlock = (context, at)
    lock.unlock()
  }

  private func recentUnlock(now: Date = Date()) -> LAContext? {
    lock.lock()
    defer { lock.unlock() }
    guard let u = unlock else { return nil }
    if now.timeIntervalSince(u.at) < Self.authValidSeconds && now >= u.at { return u.context }
    u.context.invalidate()
    unlock = nil
    return nil
  }

  private static func tag(_ alias: String) -> Data { Data("ai.surfingdog.inbox.device.\(alias)".utf8) }

  private func find(_ alias: String, context: LAContext) -> SecKey? {
    var q: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: Self.tag(alias),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
      kSecUseAuthenticationContext as String: context,
    ]
    if let group { q[kSecAttrAccessGroup as String] = group }
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let ref = out else { return nil }
    return (ref as! SecKey)
  }

  /// The device key's public half, made on first use: x and y, base64url.
  func publicKey(alias: String) throws -> (x: String, y: String) {
    let quiet = LAContext()
    quiet.interactionNotAllowed = true
    let key = try find(alias, context: quiet) ?? make(alias)
    guard let pub = SecKeyCopyPublicKey(key), let point = SecKeyCopyExternalRepresentation(pub, nil) as Data?,
      point.count == 65
    else { throw Failure.other("The device key has no public half.") }
    return (point[1..<33].base64URL, point[33..<65].base64URL)
  }

  private func make(_ alias: String) throws -> SecKey {
    guard Self.deviceSecure() else { throw Failure.noScreenLock }
    var error: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .userPresence], &error)
    else { throw Failure.other("No access control.") }
    var priv: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: Self.tag(alias),
      kSecAttrAccessControl as String: access,
    ]
    if let group { priv[kSecAttrAccessGroup as String] = group }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: priv,
    ]
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw Self.deviceSecure() ? Failure.other("The Secure Enclave did not make a key.") : Failure.noScreenLock
    }
    return key
  }

  /// A signature with the device key over `data` (UTF-8), raw r ‖ s, base64url.
  func sign(alias: String, data: String) throws -> String {
    guard let context = recentUnlock() else { throw Failure.authRequired }
    // The key is gone only when the passcode was removed (or the app removed it): connect again.
    guard let key = find(alias, context: context) else { throw Failure.keyGone }
    var error: Unmanaged<CFError>?
    guard
      let der = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(data.utf8) as CFData, &error)
        as Data?
    else {
      let code = (error?.takeRetainedValue() as Error?).map { ($0 as NSError).code } ?? 0
      let askAgain = [Int(errSecInteractionNotAllowed), Int(errSecAuthFailed), LAError.notInteractive.rawValue,
        LAError.authenticationFailed.rawValue, LAError.invalidContext.rawValue]
      throw askAgain.contains(code) ? Failure.authRequired : Failure.other("The Secure Enclave did not sign.")
    }
    return try WebPushCrypto.rawSignature(der: der).base64URL
  }

  func delete(alias: String) {
    var q: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: Self.tag(alias)]
    if let group { q[kSecAttrAccessGroup as String] = group }
    SecItemDelete(q as CFDictionary)
  }
}
