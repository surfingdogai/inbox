package ai.surfingdog.inbox;

import android.Manifest;
import android.os.Build;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.lang.ref.WeakReference;
import org.json.JSONArray;

/**
 * What the screens ask of the phone itself (ADR-026; src/lib/native.ts is the other side): the device
 * key, secure storage, the fingerprint or face, and push. Every key stays in the Android Keystore or
 * sealed under it; the screens get public halves and signatures, never a private key.
 */
@CapacitorPlugin(
    name = "InboxNative",
    permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})})
public class InboxNativePlugin extends Plugin {
  private static WeakReference<InboxNativePlugin> current = new WeakReference<>(null);
  private Keys keys;
  private SecureStore store;

  @Override
  public void load() {
    keys = new Keys(getContext());
    store = new SecureStore(getContext());
    current = new WeakReference<>(this);
  }

  /** The push service saw a new token: told to the screens, which register it with each inbox. */
  static void tokenChanged(String token) {
    InboxNativePlugin p = current.get();
    if (p == null) return;
    JSObject e = new JSObject();
    e.put("token", token);
    p.notifyListeners("pushToken", e, true);
  }

  private static String alias(PluginCall call) {
    String a = call.getString("alias", "");
    return a != null && a.matches("^[A-Za-z0-9_-]{1,64}$") ? a : null;
  }

  @PluginMethod
  public void deviceName(PluginCall call) {
    String model = Build.MODEL == null ? "Phone" : Build.MODEL;
    String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
    String name = model.toLowerCase().startsWith(maker.toLowerCase()) || maker.isEmpty() ? model : maker + " " + model;
    JSObject r = new JSObject();
    r.put("name", name.length() > 60 ? name.substring(0, 60) : name);
    call.resolve(r);
  }

  @PluginMethod
  public void deviceKey(PluginCall call) {
    String a = alias(call);
    if (a == null) {
      call.reject("alias");
      return;
    }
    try {
      String[] xy = keys.devicePublic(a);
      JSObject r = new JSObject();
      r.put("x", xy[0]);
      r.put("y", xy[1]);
      call.resolve(r);
    } catch (Exception e) {
      call.reject("The phone's keystore did not make a key.", e);
    }
  }

  @PluginMethod
  public void sign(PluginCall call) {
    String a = alias(call);
    String data = call.getString("data");
    if (a == null || data == null) {
      call.reject("alias and data");
      return;
    }
    try {
      JSObject r = new JSObject();
      r.put("signature", keys.sign(a, data));
      call.resolve(r);
    } catch (Exception e) {
      call.reject("The phone's keystore did not sign.", e);
    }
  }

  @PluginMethod
  public void deleteKeys(PluginCall call) {
    String a = alias(call);
    if (a != null) keys.delete(a);
    call.resolve();
  }

  @PluginMethod
  public void secureGet(PluginCall call) {
    String k = call.getString("key");
    JSObject r = new JSObject();
    r.put("value", k == null ? null : store.getString("app." + k));
    call.resolve(r);
  }

  @PluginMethod
  public void secureSet(PluginCall call) {
    String k = call.getString("key");
    String v = call.getString("value");
    if (k == null || v == null) {
      call.reject("key and value");
      return;
    }
    try {
      store.putString("app." + k, v);
      call.resolve();
    } catch (Exception e) {
      call.reject("Not kept.", e);
    }
  }

  @PluginMethod
  public void secureRemove(PluginCall call) {
    String k = call.getString("key");
    if (k != null) store.remove("app." + k);
    call.resolve();
  }

  private static final int AUTHENTICATORS =
      BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

  @PluginMethod
  public void canAuthenticate(PluginCall call) {
    int can = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
    JSObject r = new JSObject();
    r.put("available", can == BiometricManager.BIOMETRIC_SUCCESS);
    call.resolve(r);
  }

  /** BiometricPrompt: a fingerprint, a face, or the screen lock when the phone has no biometrics enrolled. */
  @PluginMethod
  public void authenticate(PluginCall call) {
    String reason = call.getString("reason", "Open your inbox");
    FragmentActivity activity = getActivity();
    activity.runOnUiThread(
        () -> {
          BiometricPrompt prompt =
              new BiometricPrompt(
                  activity,
                  ContextCompat.getMainExecutor(activity),
                  new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                      JSObject r = new JSObject();
                      r.put("ok", true);
                      call.resolve(r);
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence message) {
                      JSObject r = new JSObject();
                      r.put("ok", false);
                      call.resolve(r);
                    }
                  });
          BiometricPrompt.PromptInfo info =
              new BiometricPrompt.PromptInfo.Builder()
                  .setTitle(reason)
                  .setAllowedAuthenticators(AUTHENTICATORS)
                  .setConfirmationRequired(false)
                  .build();
          prompt.authenticate(info);
        });
  }

  /** Whether this build can receive notifications (Firebase configured in it) and whether they are allowed. */
  @PluginMethod
  public void pushStatus(PluginCall call) {
    JSObject r = new JSObject();
    r.put("available", firebaseReady());
    r.put("permission", permission());
    call.resolve(r);
  }

  private boolean firebaseReady() {
    try {
      return !FirebaseApp.getApps(getContext()).isEmpty();
    } catch (Exception e) {
      return false;
    }
  }

  private String permission() {
    if (Build.VERSION.SDK_INT < 33) {
      return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
    }
    PermissionState s = getPermissionState("notifications");
    return s == PermissionState.GRANTED ? "granted" : s == PermissionState.DENIED ? "denied" : "prompt";
  }

  @PluginMethod
  public void requestPushPermission(PluginCall call) {
    if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
      requestPermissionForAlias("notifications", call, "permissionAnswered");
      return;
    }
    permissionAnswered(call);
  }

  @PermissionCallback
  private void permissionAnswered(PluginCall call) {
    JSObject r = new JSObject();
    r.put("permission", permission());
    call.resolve(r);
  }

  @PluginMethod
  public void pushToken(PluginCall call) {
    if (!firebaseReady()) {
      JSObject r = new JSObject();
      r.put("token", null);
      call.resolve(r);
      return;
    }
    try {
      FirebaseMessaging.getInstance()
          .getToken()
          .addOnCompleteListener(
              task -> {
                JSObject r = new JSObject();
                r.put("token", task.isSuccessful() ? task.getResult() : null);
                call.resolve(r);
              });
    } catch (Exception e) {
      JSObject r = new JSObject();
      r.put("token", null);
      call.resolve(r);
    }
  }

  @PluginMethod
  public void pushKeys(PluginCall call) {
    String a = alias(call);
    if (a == null) {
      call.reject("alias");
      return;
    }
    try {
      String[] k = keys.pushPublic(a);
      JSObject r = new JSObject();
      r.put("p256dh", k[0]);
      r.put("auth", k[1]);
      call.resolve(r);
    } catch (Exception e) {
      call.reject("Push keys were not made.", e);
    }
  }

  @PluginMethod
  public void setInboxes(PluginCall call) {
    JSONArray list = call.getArray("inboxes", new com.getcapacitor.JSArray());
    keys.setInboxes(list);
    call.resolve();
  }
}
