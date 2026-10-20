package ai.surfingdog.inbox;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Where a notification arrives (ADR-026), whether the app is open or not. The relay sends a data-only
 * message (docs/protocol/push-relay.md): `sd` "1", `d` the relay's id for this phone at one inbox, and
 * `p` the ciphertext (base64url). It is decrypted here with the key of the inbox `d` names (with each
 * inbox's in turn when this phone does not know `d` yet), and shown. A message no key opens is
 * dropped: it was not for this phone.
 */
public class PushService extends FirebaseMessagingService {
  @Override
  public void onMessageReceived(@NonNull RemoteMessage message) {
    Map<String, String> data = message.getData();
    String payload = data.get("p");
    // `sd` is the relay's version; `v` was an early test build's.
    if (payload == null || !("1".equals(data.get("sd")) || "1".equals(data.get("v")))) return;
    byte[] bytes;
    try {
      bytes = Keys.fromB64u(payload);
    } catch (IllegalArgumentException e) {
      return;
    }
    Keys.Decrypted d = new Keys(this).decrypt(bytes, data.get("d"));
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
