import CryptoKit
import Foundation

/// Decrypts a notification the inbox encrypted for this phone (ADR-028): Web Push message encryption,
/// RFC 8291, with the aes128gcm content coding of RFC 8188. The iPhone twin of WebPushCrypto.java, held
/// to the same example (packages/spec/vectors/push.json) by Native/Tests/main.swift.
enum WebPushCrypto {
  enum Failure: Error {
    case tooShort, notP256, noDelimiter
  }

  /// The plaintext of `message` (header and one record) for the phone whose push key and
  /// authentication secret are given. Throws when it was not made for this phone.
  static func decrypt(_ message: Data, key: P256.KeyAgreement.PrivateKey, auth: Data) throws -> Data {
    let m = [UInt8](message)
    guard m.count >= 21 + 65 + 17 else { throw Failure.tooShort }
    let salt = Data(m[0..<16])
    guard m[20] == 65 else { throw Failure.notP256 }
    let senderPublic = Data(m[21..<86])
    let body = Data(m[86...])

    let sender = try P256.KeyAgreement.PublicKey(x963Representation: senderPublic)
    let ecdh = try key.sharedSecretFromKeyAgreement(with: sender).withUnsafeBytes { Data($0) }
    let phonePublic = key.publicKey.x963Representation

    // RFC 8291 §3.3-3.4.
    let prkKey = hmac(auth, ecdh)
    let ikm = hmac(prkKey, Data("WebPush: info\0".utf8) + phonePublic + senderPublic + Data([1]))
    // RFC 8188 §2.2-2.3.
    let prk = hmac(salt, ikm)
    let cek = hmac(prk, Data("Content-Encoding: aes128gcm\0\u{1}".utf8)).prefix(16)
    let nonce = hmac(prk, Data("Content-Encoding: nonce\0\u{1}".utf8)).prefix(12)

    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce), ciphertext: body.dropLast(16), tag: body.suffix(16))
    let padded = [UInt8](try AES.GCM.open(box, using: SymmetricKey(data: cek)))
    var end = padded.count - 1
    while end >= 0 && padded[end] == 0 { end -= 1 }
    guard end >= 0, padded[end] == 2 else { throw Failure.noDelimiter }
    return Data(padded[0..<end])
  }

  static func hmac(_ key: Data, _ data: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
  }

  /// ECDSA's DER signature (what the Secure Enclave gives) as the raw r ‖ s the inbox checks.
  static func rawSignature(der: Data) throws -> Data {
    try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation
  }
}

extension Data {
  init?(base64URL s: String) {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    self.init(base64Encoded: t)
  }

  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func random(_ count: Int) -> Data {
    var g = SystemRandomNumberGenerator()
    return Data((0..<count).map { _ in UInt8.random(in: 0...255, using: &g) })
  }
}
