import CryptoKit
import Foundation
import Security

/// Where a secret is kept: the Keychain on a phone, memory in the tests.
protocol SecretBox {
  func get(_ name: String) -> Data?
  func put(_ name: String, _ value: Data) throws
  func remove(_ name: String)
}

/// Secrets on the iPhone (ADR-028), the twin of SecureStore.java: Keychain items, each never in a backup
/// and never moved to another device (`…ThisDeviceOnly`), in one of two places:
///
/// - `app`: what the screens keep (the refresh tokens, the offline cache's key). Readable only while the
///   phone is unlocked, as Android's `setUnlockedDeviceRequired`, and only by the app itself: its own
///   access group, which the notification service extension does not have.
/// - `shared`: the push keys, the list of inboxes and the notification actions' nonces, in the access
///   group the app shares with its notification service extension. Readable once the phone has been
///   unlocked after it started, so a notification still opens on a locked phone. Before that first
///   unlock nothing can read them, and iOS shows the relay's placeholder, which names nobody.
struct Keychain: SecretBox {
  struct Failed: Error {
    let status: OSStatus
  }

  let service: String
  /// "<team id>.ai.surfingdog.inbox" or "….shared", from Info.plist (the build fills in the team).
  let group: String?
  let accessible: CFString

  static func app(bundle: Bundle = .main) -> Keychain {
    Keychain(
      service: "ai.surfingdog.inbox.app", group: bundle.object(forInfoDictionaryKey: "SDIKeychainAppGroup") as? String,
      accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
  }

  static func shared(bundle: Bundle = .main) -> Keychain {
    Keychain(
      service: "ai.surfingdog.inbox.push", group: bundle.object(forInfoDictionaryKey: "SDIKeychainGroup") as? String,
      accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
  }

  private func query(_ name: String) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: name,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let group { q[kSecAttrAccessGroup as String] = group }
    return q
  }

  func get(_ name: String) -> Data? {
    var q = query(name)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    // Locked (an `app` item), or never kept: as if it was never kept, as on Android.
    return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }

  func put(_ name: String, _ value: Data) throws {
    let update: [String: Any] = [kSecValueData as String: value, kSecAttrAccessible as String: accessible]
    var status = SecItemUpdate(query(name) as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var add = query(name)
      add.merge(update) { $1 }
      status = SecItemAdd(add as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw Failed(status: status) }
  }

  func remove(_ name: String) {
    SecItemDelete(query(name) as CFDictionary)
  }
}

/// The tests' box: nothing touches a real keychain.
final class MemoryBox: SecretBox {
  private var items: [String: Data] = [:]
  func get(_ name: String) -> Data? { items[name] }
  func put(_ name: String, _ value: Data) throws { items[name] = value }
  func remove(_ name: String) { items[name] = nil }
}

/// An inbox the phone is connected to, as the notification service extension needs it.
struct Inbox: Codable, Equatable {
  let alias: String
  let origin: String
  let name: String
  /// The relay's id for this phone at this inbox (`d` in every message), "" until the inbox says it.
  let device: String
}

/// What the app and its notification service extension share: the push keys of each inbox (an ECDH
/// P-256 key and a 16-byte authentication secret, RFC 8291), the inboxes, and one-time action nonces.
/// The twin of Keys.java's push half and Notifier.java's nonces.
struct PushStore {
  let box: SecretBox
  /// An action's nonce lasts as long as a notification may wait in the list.
  static let actionTTL: TimeInterval = 2 * 86_400

  /// The push key's public point and the authentication secret, base64url, made on first use.
  func publicKeys(alias: String) throws -> (p256dh: String, auth: String) {
    if let priv = box.get("push.priv.\(alias)"), let auth = box.get("push.auth.\(alias)"),
      let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: priv)
    {
      return (key.publicKey.x963Representation.base64URL, auth.base64URL)
    }
    let key = P256.KeyAgreement.PrivateKey()
    let auth = Data.random(16)
    try box.put("push.priv.\(alias)", key.rawRepresentation)
    try box.put("push.auth.\(alias)", auth)
    return (key.publicKey.x963Representation.base64URL, auth.base64URL)
  }

  func delete(alias: String) {
    box.remove("push.priv.\(alias)")
    box.remove("push.auth.\(alias)")
  }

  var inboxes: [Inbox] {
    guard let data = box.get("inboxes") else { return [] }
    return (try? JSONDecoder().decode([Inbox].self, from: data)) ?? []
  }

  func setInboxes(_ list: [Inbox]) throws {
    try box.put("inboxes", JSONEncoder().encode(list))
  }

  /// The plaintext of a notification and the inbox whose key opened it; nil when none does. Only the
  /// inbox `device` names is tried when this phone knows it; otherwise each in turn.
  func decrypt(_ message: Data, device: String?) -> (inbox: Inbox, json: String)? {
    let all = inboxes
    var tried = all.filter { device != nil && !device!.isEmpty && $0.device == device }
    if tried.isEmpty { tried = all }
    for inbox in tried {
      guard let priv = box.get("push.priv.\(inbox.alias)"), let auth = box.get("push.auth.\(inbox.alias)"),
        let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: priv),
        let plain = try? WebPushCrypto.decrypt(message, key: key, auth: auth),
        let json = String(data: plain, encoding: .utf8)
      else { continue }
      return (inbox, json)
    }
    return nil
  }

  private struct Kept: Codable {
    let item: String
    let event: String
    let until: Double
  }

  private func actions() -> [String: Kept] {
    guard let data = box.get("actions") else { return [:] }
    return (try? JSONDecoder().decode([String: Kept].self, from: data)) ?? [:]
  }

  /// A nonce for one action on one item, kept until the app claims it or it runs out.
  func nonce(item: String, event: String, now: Date = Date()) -> String {
    let nonce = Data.random(16).base64URL
    // Old ones go as new ones come: the store never grows past the notifications in the list.
    var kept = actions().filter { $0.value.until >= now.timeIntervalSince1970 }
    kept[nonce] = Kept(item: item, event: event, until: now.timeIntervalSince1970 + Self.actionTTL)
    try? box.put("actions", JSONEncoder().encode(kept))
    return nonce
  }

  /// Whether `nonce` was made here for this item and action and has not run out; spent either way.
  func claim(nonce: String, item: String, event: String, now: Date = Date()) -> Bool {
    guard !nonce.isEmpty else { return false }
    var kept = actions()
    guard let k = kept.removeValue(forKey: nonce) else { return false }
    try? box.put("actions", JSONEncoder().encode(kept))
    return k.item == item && k.event == event && k.until >= now.timeIntervalSince1970
  }
}
