package ai.surfingdog.inbox;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Where a notification arrives (ADR-026), whether the app is open or not. The relay sends a data-only
 * message holding ciphertext (`p`, base64url); it is decrypted here with the key of the inbox it was
 * made for, and shown. A message no inbox's key opens is dropped: it was not for this phone.
 */
public class PushService extends FirebaseMessagingService {
  @Override
  public void onMessageReceived(@NonNull RemoteMessage message) {
    Map<String, String> data = message.getData();
    String payload = data.get("p");
    if (payload == null || !"1".equals(data.get("v"))) return;
    byte[] bytes;
    try {
      bytes = Keys.fromB64u(payload);
    } catch (IllegalArgumentException e) {
      return;
    }
    Keys.Decrypted d = new Keys(this).decrypt(bytes);
    if (d == null) return;
    Notifier.channels(this);
    Notifier.show(this, d.inbox, d.json);
  }

  @Override
  public void onNewToken(@NonNull String token) {
    // The app registers the new token with each inbox the next time it runs, or now if it is running.
    InboxNativePlugin.tokenChanged(token);
  }
}
