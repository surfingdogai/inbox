package ai.surfingdog.inbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.security.SecureRandom;
import java.util.Map;
import org.json.JSONObject;

/**
 * Shows a notification the inbox sent (ADR-026), as it is: its words were chosen by the inbox for this
 * phone's settings (no customer name unless "Show details" is on). Tapping it, or its action, only
 * opens the item in the app, with the action chosen; the app asks for the owner's fingerprint or face
 * before an Accept and does nothing until the owner presses it there. Nothing is ever done from here.
 *
 * With details on, the name and words are the private version: on a lock screen set to hide sensitive
 * content, Android shows the public version instead, which has neither.
 *
 * An action carries a one-time nonce kept here, so the app takes an action only from one of its own
 * notifications: a link another app or a web page opens can open an item, never stage an Accept.
 */
public final class Notifier {
  static final String REQUESTS = "requests";
  static final String HANDLED = "handled";
  private static final String SCHEME = "ai.surfingdog.inbox";
  private static final String ACTIONS = "sdi.actions";
  /** An action's nonce lasts as long as a notification may wait in the shade. */
  private static final long ACTION_TTL_MS = 2L * 86_400_000L;

  private Notifier() {}

  public static void channels(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = context.getSystemService(NotificationManager.class);
    if (nm == null) return;
    NotificationChannel requests =
        new NotificationChannel(REQUESTS, "New requests", NotificationManager.IMPORTANCE_HIGH);
    requests.setDescription("Bookings, orders, quotes and messages that need you.");
    NotificationChannel handled =
        new NotificationChannel(HANDLED, "Answered by your rules", NotificationManager.IMPORTANCE_LOW);
    handled.setDescription("What your inbox answered on its own.");
    nm.createNotificationChannel(requests);
    nm.createNotificationChannel(handled);
  }

  private static PendingIntent open(Context context, Uri uri, int code) {
    Intent intent = new Intent(Intent.ACTION_VIEW, uri, context, MainActivity.class);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(
        context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private static SharedPreferences actions(Context context) {
    return context.getApplicationContext().getSharedPreferences(ACTIONS, Context.MODE_PRIVATE);
  }

  /** A nonce for one action on one item, kept until the app claims it or it runs out. */
  static String nonceFor(Context context, String item, String event) {
    byte[] b = new byte[16];
    new SecureRandom().nextBytes(b);
    String nonce = Keys.b64u(b);
    long now = System.currentTimeMillis();
    SharedPreferences prefs = actions(context);
    SharedPreferences.Editor edit = prefs.edit();
    // Old ones go as new ones come: the store never grows past the notifications in the shade.
    for (Map.Entry<String, ?> e : prefs.getAll().entrySet()) {
      if (until(String.valueOf(e.getValue())) < now) edit.remove(e.getKey());
    }
    edit.putString(nonce, item + "\n" + event + "\n" + (now + ACTION_TTL_MS)).apply();
    return nonce;
  }

  /** Whether `nonce` was made here for this item and action, and has not run out; spent either way. */
  static boolean claim(Context context, String nonce, String item, String event) {
    if (nonce == null || nonce.isEmpty()) return false;
    SharedPreferences prefs = actions(context);
    String kept = prefs.getString(nonce, null);
    if (kept == null) return false;
    prefs.edit().remove(nonce).apply();
    String[] v = kept.split("\n", 3);
    return v.length == 3 && v[0].equals(item) && v[1].equals(event) && until(kept) >= System.currentTimeMillis();
  }

  /** When a kept nonce runs out; 0 for one that does not read. */
  private static long until(String kept) {
    String[] v = kept.split("\n", 3);
    try {
      return v.length == 3 ? Long.parseLong(v[2]) : 0L;
    } catch (NumberFormatException e) {
      return 0L;
    }
  }

  /** The notification as Android would show it; null for a payload that is not one. Shown by {@link #show}. */
  static Notification build(Context context, Keys.Inbox inbox, String json) {
    JSONObject p;
    try {
      p = new JSONObject(json);
    } catch (Exception e) {
      return null;
    }
    if (p.optInt("v") != 1) return null;
    String kind = p.optString("kind", "");
    String item = p.optString("item", "");
    String title = p.optString("title", "");
    String body = p.optString("body", "");
    String who = p.optString("who", "");
    String text = p.optString("text", "");
    boolean free = p.optBoolean("free", false);
    if (title.isEmpty()) return null;
    String channel = "handled".equals(kind) ? HANDLED : REQUESTS;

    // The item's address in the app, with the minimal words: what the app shows while it cannot reach
    // the inbox. Never the name or the customer's words.
    Uri.Builder u = new Uri.Builder().scheme(SCHEME).appendQueryParameter("o", inbox.origin);
    if (!item.isEmpty()) {
      u.authority("i").appendPath(item).appendQueryParameter("t", title).appendQueryParameter("b", body);
    } else {
      u.authority("open");
    }
    Uri openUri = u.build();
    int id = notificationId(inbox, item, p.optLong("at"));

    // What any lock screen may show: the minimal words, as sent with details off.
    NotificationCompat.Builder minimal =
        new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_inbox)
            .setContentTitle(title)
            .setContentText(body)
            .setSubText(inbox.name);

    boolean details = !who.isEmpty() || !text.isEmpty();
    String headline = who.isEmpty() ? title : who;
    String line = who.isEmpty() ? body : title + " · " + body;
    NotificationCompat.Builder b =
        new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_inbox)
            .setContentTitle(headline)
            .setContentText(line)
            .setSubText(inbox.name)
            .setGroup(inbox.alias)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(open(context, openUri, id));
    if (details) {
      // Names and words are private: a lock screen that hides sensitive content shows the minimal one.
      b.setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(minimal.build());
    } else {
      // The words were chosen for a lock screen already: nothing in them is the customer's.
      b.setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
    }
    String expanded = line + (free ? "\nFree in your calendar" : "") + (text.isEmpty() ? "" : "\n" + text);
    if (!text.isEmpty() || free) b.setStyle(new NotificationCompat.BigTextStyle().bigText(expanded));

    JSONObject action = p.optJSONObject("action");
    if (action != null && !item.isEmpty()) {
      String event = action.optString("event");
      Uri actUri =
          openUri
              .buildUpon()
              .appendQueryParameter("a", event)
              .appendQueryParameter("n", nonceFor(context, item, event))
              .build();
      b.addAction(0, action.optString("label", "Accept"), open(context, actUri, id + 1));
      b.addAction(0, "Open", open(context, openUri, id + 2));
    }
    return b.build();
  }

  static int notificationId(Keys.Inbox inbox, String item, long at) {
    return (inbox.alias + item + at).hashCode();
  }

  public static void show(Context context, Keys.Inbox inbox, String json) {
    Notification n = build(context, inbox, json);
    if (n == null) return;
    JSONObject p;
    try {
      p = new JSONObject(json);
    } catch (Exception e) {
      return;
    }
    try {
      NotificationManagerCompat.from(context)
          .notify(notificationId(inbox, p.optString("item", ""), p.optLong("at")), n);
    } catch (SecurityException noPermission) {
      // Notifications are off for this app: the inbox shows it when the app opens.
    }
  }
}
