import Foundation

/// A notification as the iPhone shows it, from what the inbox sent (packages/core/src/phones/payload.ts),
/// the twin of Notifier.build in Notifier.java: its words were chosen by the inbox for this phone's
/// settings (no customer's name unless "Show details" is on). Tapping it, or its action, only opens the
/// item in the app with the action chosen; nothing is ever done from a notification.
struct Shown: Equatable {
  /// The customer's name with details on, else the inbox's title ("New booking request").
  let title: String
  /// The business, as Android's subtext.
  let subtitle: String
  let body: String
  /// One thread per inbox, as Android groups them.
  let thread: String
  /// `sdi.accept` (Accept and Open), `sdi.request`, or `sdi.handled` (quiet: what rules answered).
  let category: String
  /// The item in the app, with only the minimal words (what the app shows while it cannot reach the inbox).
  let url: String
  /// The same with the action chosen and its one-time nonce; nil when there is no action.
  let actionURL: String?

  static let scheme = "ai.surfingdog.inbox"
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  /// Nil for a payload that is not one (not version 1, or no title).
  static func from(json: String, inbox: Inbox, nonce: (_ item: String, _ event: String) -> String) -> Shown? {
    guard let data = json.data(using: .utf8),
      let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      (p["v"] as? Int) == 1
    else { return nil }
    let str = { (k: String) in (p[k] as? String) ?? "" }
    let kind = str("kind")
    let item = str("item")
    let title = str("title")
    let body = str("body")
    let who = str("who")
    let text = str("text")
    let free = (p["free"] as? Bool) ?? false
    guard !title.isEmpty else { return nil }

    var url = "\(scheme)://"
    if item.isEmpty {
      url += "open?o=\(encode(inbox.origin))"
    } else {
      url += "i/\(encode(item))?o=\(encode(inbox.origin))&t=\(encode(title))&b=\(encode(body))"
    }

    let line = who.isEmpty ? body : "\(title) · \(body)"
    let expanded = line + (free ? "\nFree in your calendar" : "") + (text.isEmpty ? "" : "\n\(text)")

    var category = kind == "handled" ? "sdi.handled" : "sdi.request"
    var actionURL: String?
    if let action = p["action"] as? [String: Any], let event = action["event"] as? String, !event.isEmpty,
      !item.isEmpty
    {
      category = "sdi.accept"
      actionURL = url + "&a=\(encode(event))&n=\(encode(nonce(item, event)))"
    }
    return Shown(
      title: who.isEmpty ? title : who, subtitle: inbox.name, body: expanded, thread: inbox.alias,
      category: category, url: url, actionURL: actionURL)
  }

  /// Percent-encoding for a query value or a path segment: everything but RFC 3986's unreserved
  /// characters, so "&", "=", "+" and "#" in the words never break the link.
  static func encode(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
  }
}
