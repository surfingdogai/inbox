import Foundation
import UserNotifications

/// Where a notification arrives on an iPhone (ADR-028), the twin of PushService.java. iOS shows a
/// notification only if the push carries one, so the relay sends a neutral placeholder that names
/// nobody, with `mutable-content` and the relay's data beside it (docs/protocol/push-relay.md):
/// `sd` "1", `d` the relay's id for this phone at one inbox, `p` the ciphertext (base64url). This
/// extension decrypts `p` with the key of the inbox `d` names and puts the inbox's words in place of the
/// placeholder before anything is shown.
///
/// Unlike Android, a message no key opens cannot be dropped here without Apple's notification-filtering
/// entitlement: iOS then shows the placeholder, and tapping it only opens the app.
final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var placeholder: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    deliver = contentHandler
    placeholder = request.content.mutableCopy() as? UNMutableNotificationContent
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    let info = request.content.userInfo
    let store = PushStore(box: Keychain.shared())
    guard (info["sd"] as? String) == "1", let p = info["p"] as? String, let message = Data(base64URL: p),
      let opened = store.decrypt(message, device: info["d"] as? String),
      let shown = Shown.from(json: opened.json, inbox: opened.inbox, nonce: { store.nonce(item: $0, event: $1) })
    else {
      finish(content)
      return
    }
    content.title = shown.title
    content.subtitle = shown.subtitle
    content.body = shown.body
    content.threadIdentifier = shown.thread
    content.categoryIdentifier = shown.category
    // The ciphertext is not kept with the notification; what the app needs to open the item is.
    var kept: [String: Any] = ["sdi.url": shown.url]
    if let a = shown.actionURL { kept["sdi.action"] = a }
    content.userInfo = kept
    if shown.category == "sdi.handled" {
      // What rules answered: in the list, without a sound or lighting the screen (Android's quiet channel).
      content.sound = nil
      content.interruptionLevel = .passive
    } else {
      content.sound = .default
    }
    finish(content)
  }

  override func serviceExtensionTimeWillExpire() {
    // Out of time: the placeholder, which names nobody.
    if let placeholder { finish(placeholder) }
  }

  /// Hands iOS the notification once.
  private func finish(_ content: UNNotificationContent) {
    let d = deliver
    deliver = nil
    d?(content)
  }
}
