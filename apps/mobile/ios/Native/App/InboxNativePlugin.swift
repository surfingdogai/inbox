import Capacitor
import Foundation
import LocalAuthentication
import UIKit
import UserNotifications

/// What the screens ask of the iPhone itself (ADR-028; src/lib/native.ts is the other side), the twin of
/// InboxNativePlugin.java, method for method: the device key, secure storage, Face ID or Touch ID, and
/// push. Every key stays in the Secure Enclave or the Keychain; the screens get public halves and
/// signatures, never a private key.
@objc(InboxNativePlugin)
public class InboxNativePlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
  public let identifier = "InboxNativePlugin"
  public let jsName = "InboxNative"
  public let pluginMethods: [CAPPluginMethod] = [
    "deviceName", "deviceKey", "sign", "deleteKeys", "secureGet", "secureSet", "secureRemove", "deviceSecure",
    "canAuthenticate", "authenticate", "claimAction", "pushStatus", "requestPushPermission", "pushToken",
    "pushKeys", "setInboxes",
  ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

  private let keys = DeviceKeys()
  /// The screens' secrets: readable only while the phone is unlocked, and only by the app.
  private let store = Keychain.app()
  /// The push keys, the inboxes and the actions' nonces, shared with the notification service extension.
  private let push = PushStore(box: Keychain.shared())
  private var token: String?
  private var waitingForToken: [CAPPluginCall] = []

  override public func load() {
    bridge?.notificationRouter.pushNotificationHandler = self
    let accept = UNNotificationAction(
      identifier: "accept", title: "Accept", options: [.foreground, .authenticationRequired])
    let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])
    UNUserNotificationCenter.current().setNotificationCategories([
      UNNotificationCategory(identifier: "sdi.accept", actions: [accept, open], intentIdentifiers: []),
      UNNotificationCategory(identifier: "sdi.request", actions: [], intentIdentifiers: []),
      UNNotificationCategory(identifier: "sdi.handled", actions: [], intentIdentifiers: []),
    ])
    NotificationCenter.default.addObserver(
      self, selector: #selector(registered(_:)), name: .capacitorDidRegisterForRemoteNotifications, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(notRegistered(_:)), name: .capacitorDidFailToRegisterForRemoteNotifications,
      object: nil)
  }

  private func alias(_ call: CAPPluginCall) -> String? {
    let a = call.getString("alias") ?? ""
    return a.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil ? a : nil
  }

  private func reject(_ call: CAPPluginCall, _ failure: Error) {
    switch failure as? DeviceKeys.Failure {
    case .authRequired: call.reject("Unlock to continue.", "auth_required")
    case .keyGone: call.reject("This phone's passcode changed: connect it again.", "key_gone")
    case .noScreenLock: call.reject("Set a passcode on this phone first.", "no_screen_lock")
    default: call.reject("The phone's keychain did not do it.", nil, failure)
    }
  }

  // ---- the device and its key ----

  /// "iPhone": iOS gives an app the phone's own name only with an entitlement Apple grants case by case.
  @objc func deviceName(_ call: CAPPluginCall) {
    call.resolve(["name": UIDevice.current.model])
  }

  @objc func deviceKey(_ call: CAPPluginCall) {
    guard let a = alias(call) else { return call.reject("alias") }
    do {
      let k = try keys.publicKey(alias: a)
      call.resolve(["x": k.x, "y": k.y])
    } catch { reject(call, error) }
  }

  @objc func deviceSecure(_ call: CAPPluginCall) {
    call.resolve(["secure": DeviceKeys.deviceSecure()])
  }

  @objc func sign(_ call: CAPPluginCall) {
    guard let a = alias(call), let data = call.getString("data") else { return call.reject("alias and data") }
    do {
      call.resolve(["signature": try keys.sign(alias: a, data: data)])
    } catch { reject(call, error) }
  }

  @objc func deleteKeys(_ call: CAPPluginCall) {
    if let a = alias(call) {
      keys.delete(alias: a)
      push.delete(alias: a)
    }
    call.resolve()
  }

  // ---- secure storage ----

  @objc func secureGet(_ call: CAPPluginCall) {
    guard let k = call.getString("key") else { return call.resolve(["value": NSNull()]) }
    let v = store.get("app.\(k)").flatMap { String(data: $0, encoding: .utf8) }
    call.resolve(["value": v ?? NSNull()])
  }

  @objc func secureSet(_ call: CAPPluginCall) {
    guard let k = call.getString("key"), let v = call.getString("value") else { return call.reject("key and value") }
    do {
      try store.put("app.\(k)", Data(v.utf8))
      call.resolve()
    } catch { call.reject("Not kept.", nil, error) }
  }

  @objc func secureRemove(_ call: CAPPluginCall) {
    if let k = call.getString("key") { store.remove("app.\(k)") }
    call.resolve()
  }

  // ---- Face ID, Touch ID or the passcode ----

  @objc func canAuthenticate(_ call: CAPPluginCall) {
    call.resolve(["available": DeviceKeys.deviceSecure()])
  }

  /// Face ID or Touch ID, or the passcode: what also lets the device key sign for five minutes.
  @objc func authenticate(_ call: CAPPluginCall) {
    let title = call.getString("title") ?? "Open your inbox"
    let reason = call.getString("subtitle").flatMap { $0.isEmpty ? nil : $0 } ?? title
    let context = LAContext()
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [keys] ok, _ in
      if ok { keys.unlocked(with: context) }
      call.resolve(["ok": ok])
    }
  }

  @objc func claimAction(_ call: CAPPluginCall) {
    let ok = push.claim(
      nonce: call.getString("nonce") ?? "", item: call.getString("item") ?? "", event: call.getString("event") ?? "")
    call.resolve(["ok": ok])
  }

  // ---- push ----

  private func permission(_ done: @escaping (String) -> Void) {
    UNUserNotificationCenter.current().getNotificationSettings { s in
      switch s.authorizationStatus {
      case .authorized, .provisional, .ephemeral: done("granted")
      case .denied: done("denied")
      default: done("prompt")
      }
    }
  }

  /// Always available: an iPhone build needs no push configuration file, only its entitlement.
  @objc func pushStatus(_ call: CAPPluginCall) {
    permission { call.resolve(["available": true, "permission": $0]) }
  }

  @objc func requestPushPermission(_ call: CAPPluginCall) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
      self.permission { call.resolve(["permission": $0]) }
    }
  }

  /// The APNs device token, in hex as the relay takes it; null when notifications are not allowed.
  @objc func pushToken(_ call: CAPPluginCall) {
    permission { p in
      guard p == "granted" else { return call.resolve(["token": NSNull()]) }
      DispatchQueue.main.async {
        if let t = self.token { return call.resolve(["token": t]) }
        self.waitingForToken.append(call)
        UIApplication.shared.registerForRemoteNotifications()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.answerWaiting(nil) }
      }
    }
  }

  private func answerWaiting(_ token: String?) {
    let calls = waitingForToken
    waitingForToken = []
    for c in calls { c.resolve(["token": token ?? NSNull()]) }
  }

  @objc private func registered(_ n: Notification) {
    guard let data = n.object as? Data else { return }
    let hex = data.map { String(format: "%02x", $0) }.joined()
    DispatchQueue.main.async {
      let changed = self.token != nil && self.token != hex
      self.token = hex
      self.answerWaiting(hex)
      // A new token: the screens register it with each inbox, as on Android.
      if changed { self.notifyListeners("pushToken", data: ["token": hex], retainUntilConsumed: true) }
    }
  }

  @objc private func notRegistered(_ n: Notification) {
    DispatchQueue.main.async { self.answerWaiting(nil) }
  }

  @objc func pushKeys(_ call: CAPPluginCall) {
    guard let a = alias(call) else { return call.reject("alias") }
    do {
      let k = try push.publicKeys(alias: a)
      call.resolve(["p256dh": k.p256dh, "auth": k.auth])
    } catch { call.reject("Push keys were not made.", nil, error) }
  }

  @objc func setInboxes(_ call: CAPPluginCall) {
    let list = (call.getArray("inboxes") ?? []).compactMap { v -> Inbox? in
      guard let o = v as? JSObject, let alias = o["alias"] as? String, let origin = o["origin"] as? String else {
        return nil
      }
      return Inbox(alias: alias, origin: origin, name: o["name"] as? String ?? "", device: o["device"] as? String ?? "")
    }
    do {
      try push.setInboxes(list)
      call.resolve()
    } catch { call.reject("Not kept.", nil, error) }
  }

  // ---- notifications, once shown ----

  /// In the app already: shown all the same, as on Android.
  public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }

  /// A tap, or Accept: opens the item in the app, with the action chosen (and its nonce) for Accept. The
  /// screens read it as any opened link, and ask for Face ID before they show anything to accept.
  public func didReceive(response: UNNotificationResponse) {
    let info = response.notification.request.content.userInfo
    let link = response.actionIdentifier == "accept" ? info["sdi.action"] as? String : info["sdi.url"] as? String
    guard let s = link ?? info["sdi.url"] as? String, let url = URL(string: s) else { return }
    NotificationCenter.default.post(name: .capacitorOpenURL, object: ["url": url as NSURL, "options": [String: Any]()])
  }
}
