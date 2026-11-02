import CryptoKit
import Foundation

// The iPhone's shared code held to what the inbox and the Android app are held to: RFC 8291's own example
// (packages/spec/vectors/push.json), and Notifier.java's choices for what a notification says. Runs on a
// Mac with only the Command Line Tools: apps/mobile/scripts/check-ios-native.sh.

var failures = 0
func check(_ ok: Bool, _ what: String) {
  print(ok ? "ok   \(what)" : "FAIL \(what)")
  if !ok { failures += 1 }
}

let vectorsPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "packages/spec/vectors/push.json"
let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: vectorsPath))) as! [String: Any]
let rfc = vectors["rfc8291"] as! [String: String]
func b64(_ k: String) -> Data { Data(base64URL: rfc[k]!)! }

// RFC 8291 Appendix A, as the phone receives it.
let ua = try P256.KeyAgreement.PrivateKey(rawRepresentation: b64("ua_private"))
check(ua.publicKey.x963Representation == b64("ua_public"), "the phone's public point is the RFC's")
let plain = try WebPushCrypto.decrypt(b64("message"), key: ua, auth: b64("auth_secret"))
check(String(data: plain, encoding: .utf8) == "When I grow up, I want to be a watermelon", "decrypts the RFC's message")
check((try? WebPushCrypto.decrypt(b64("message"), key: P256.KeyAgreement.PrivateKey(), auth: b64("auth_secret"))) == nil,
  "refuses a message for another phone")
check((try? WebPushCrypto.decrypt(b64("message"), key: ua, auth: Data(repeating: 0, count: 16))) == nil,
  "refuses a message with another authentication secret")
check((try? WebPushCrypto.decrypt(b64("message").prefix(90), key: ua, auth: b64("auth_secret"))) == nil, "refuses a cut message")

// ECDSA: the Secure Enclave gives DER; the inbox checks raw r ‖ s.
let signer = P256.Signing.PrivateKey()
let sig = try signer.signature(for: Data("pair".utf8))
let raw = try WebPushCrypto.rawSignature(der: sig.derRepresentation)
check(raw.count == 64 && raw == sig.rawRepresentation, "a DER signature becomes raw r ‖ s")
check(Data(base64URL: raw.base64URL) == raw && !raw.base64URL.contains("="), "base64url without padding, both ways")

// The push store: the inbox's key opens it, the device picks the inbox.
let box = MemoryBox()
let store = PushStore(box: box)
let home = Inbox(alias: "a1", origin: "https://inbox.example", name: "Cut & Co", device: "pd_home")
try box.put("push.priv.a1", ua.rawRepresentation)
try box.put("push.auth.a1", b64("auth_secret"))
let other = Inbox(alias: "a2", origin: "https://other.example", name: "Other", device: "pd_other")
_ = try store.publicKeys(alias: "a2")
try store.setInboxes([other, home])
check(store.inboxes == [other, home], "keeps the inboxes")
check(store.decrypt(b64("message"), device: "pd_home")?.inbox == home, "opens with the inbox the device names")
check(store.decrypt(b64("message"), device: nil)?.inbox == home, "tries each inbox when the device is not known")
check(store.decrypt(b64("message"), device: "pd_other") == nil, "only the named inbox is tried when the device is known")
let keys = try store.publicKeys(alias: "a1")
check(keys.p256dh == rfc["ua_public"] && keys.auth == rfc["auth_secret"], "gives the push keys it holds")
store.delete(alias: "a1")
check(store.decrypt(b64("message"), device: "pd_home") == nil, "a removed inbox's messages open no more")
let fresh = try store.publicKeys(alias: "a3")
check(Data(base64URL: fresh.p256dh)?.count == 65 && Data(base64URL: fresh.auth)?.count == 16, "makes push keys: a point and 16 bytes")

// Action nonces: once, for that item and action, not after two days.
let n = store.nonce(item: "itm_1", event: "confirm")
check(!store.claim(nonce: n, item: "itm_2", event: "confirm"), "a nonce is for its own item")
check(!store.claim(nonce: n, item: "itm_1", event: "confirm"), "and is spent by any claim")
let n2 = store.nonce(item: "itm_1", event: "confirm")
check(store.claim(nonce: n2, item: "itm_1", event: "confirm"), "a nonce claims its own action")
check(!store.claim(nonce: n2, item: "itm_1", event: "confirm"), "only once")
let n3 = store.nonce(item: "itm_1", event: "confirm", now: Date(timeIntervalSinceNow: -3 * 86_400))
check(!store.claim(nonce: n3, item: "itm_1", event: "confirm"), "not after two days")
check(!store.claim(nonce: "", item: "itm_1", event: "confirm"), "no nonce, no action")

// What a notification says (Notifier.java's choices).
let booking = """
  {"v":1,"t":"item","item":"itm_1","kind":"booking","title":"New booking request",
   "body":"Tue 21 Oct, 14:00 · Cut & finish · €48.00","free":true,
   "action":{"event":"confirm","label":"Accept 14:00"},"at":1792490400000}
  """
let s = Shown.from(json: booking, inbox: home, nonce: { _, _ in "N1" })!
check(s.title == "New booking request" && s.subtitle == "Cut & Co" && s.thread == "a1", "minimal: the inbox's own words")
check(s.body == "Tue 21 Oct, 14:00 · Cut & finish · €48.00\nFree in your calendar", "says when the time is free")
check(s.category == "sdi.accept", "offers Accept when the inbox sent an action")
check(
  s.url == "ai.surfingdog.inbox://i/itm_1?o=https%3A%2F%2Finbox.example&t=New%20booking%20request"
    + "&b=Tue%2021%20Oct%2C%2014%3A00%20%C2%B7%20Cut%20%26%20finish%20%C2%B7%20%E2%82%AC48.00", "opens the item, words encoded")
check(s.actionURL == s.url + "&a=confirm&n=N1", "Accept opens it with the action and the nonce")
let detailed = Shown.from(
  json: #"{"v":1,"item":"itm_2","kind":"message","title":"Message","body":"Today","who":"Ana","text":"Hello"}"#,
  inbox: home, nonce: { _, _ in "x" })!
check(detailed.title == "Ana" && detailed.body == "Message · Today\nHello", "Show details: the name and first words")
check(detailed.category == "sdi.request" && detailed.actionURL == nil, "no action, no Accept")
let handled = Shown.from(json: #"{"v":1,"item":"itm_3","kind":"handled","title":"Answered"}"#, inbox: home, nonce: { _, _ in "x" })!
check(handled.category == "sdi.handled", "what rules answered is quiet")
let test = Shown.from(json: #"{"v":1,"t":"test","title":"Test"}"#, inbox: home, nonce: { _, _ in "x" })!
check(test.url == "ai.surfingdog.inbox://open?o=https%3A%2F%2Finbox.example", "a test opens the app")
check(Shown.from(json: #"{"v":2,"title":"x"}"#, inbox: home, nonce: { _, _ in "x" }) == nil, "not version 1: not shown")
check(Shown.from(json: #"{"v":1,"title":""}"#, inbox: home, nonce: { _, _ in "x" }) == nil, "no title: not shown")
check(Shown.from(json: "not json", inbox: home, nonce: { _, _ in "x" }) == nil, "not JSON: not shown")

print(failures == 0 ? "all passed" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
