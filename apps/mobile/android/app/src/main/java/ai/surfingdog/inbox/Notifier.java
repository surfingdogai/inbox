package ai.surfingdog.inbox;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONObject;

/**
 * Shows a notification the inbox sent (ADR-026), as it is: its words were chosen by the inbox for this
 * phone's settings (no customer name unless "Show details" is on). Tapping it, or its action, only
 * opens the item in the app, with the action chosen; the app asks for the owner's fingerprint or face
 * before an Accept and does nothing until the owner presses it there. Nothing is ever done from here.
 */
public final class Notifier {
  static final String REQUESTS = "requests";
  static final String HANDLED = "handled";
  private static final String SCHEME = "ai.surfingdog.inbox";

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

  public static void show(Context context, Keys.Inbox inbox, String json) {
    JSONObject p;
    try {
      p = new JSONObject(json);
    } catch (Exception e) {
      return;
    }
    if (p.optInt("v") != 1) return;
    String kind = p.optString("kind", "");
    String item = p.optString("item", "");
    String title = p.optString("title", "");
    String body = p.optString("body", "");
    String who = p.optString("who", "");
    String text = p.optString("text", "");
    if (title.isEmpty()) return;

    Uri.Builder u = new Uri.Builder().scheme(SCHEME).appendQueryParameter("o", inbox.origin);
    if (!item.isEmpty()) u.authority("i").appendPath(item);
    else u.authority("open");
    Uri openUri = u.build();
    int id = (inbox.alias + item + p.optLong("at")).hashCode();

    String headline = who.isEmpty() ? title : who;
    String line = who.isEmpty() ? body : title + " · " + body;
    NotificationCompat.Builder b =
        new NotificationCompat.Builder(context, "handled".equals(kind) ? HANDLED : REQUESTS)
            .setSmallIcon(R.drawable.ic_stat_inbox)
            .setContentTitle(headline)
            .setContentText(line)
            .setSubText(inbox.name)
            .setGroup(inbox.alias)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // What it shows was chosen for the lock screen already: minimal unless the owner asked for details.
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open(context, openUri, id));
    if (!text.isEmpty()) b.setStyle(new NotificationCompat.BigTextStyle().bigText(line + "\n" + text));

    JSONObject action = p.optJSONObject("action");
    if (action != null && !item.isEmpty()) {
      Uri actUri = openUri.buildUpon().appendQueryParameter("a", action.optString("event")).build();
      b.addAction(0, action.optString("label", "Accept"), open(context, actUri, id + 1));
      b.addAction(0, "Open", open(context, openUri, id + 2));
    }
    try {
      NotificationManagerCompat.from(context).notify(id, b.build());
    } catch (SecurityException noPermission) {
      // Notifications are off for this app: the inbox shows it when the app opens.
    }
  }
}
