package ai.surfingdog.inbox;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The phone's keys for each inbox it is connected to (ADR-028), under the inbox's alias:
 *
 * - the device key, ECDSA P-256, made inside the Android Keystore and never exported: the inbox holds
 *   its public half and checks a signature from it each time the phone pairs or refreshes its token.
 *   It signs only within five minutes of the owner unlocking the phone or the app (a fingerprint, a
 *   face of the strong kind, or the screen lock), so a token taken from a phone left unlocked on a
 *   table, or from the app's memory, cannot be renewed by anyone but the owner. A phone with no
 *   screen lock cannot make one at all: connecting asks for a screen lock first;
 * - the push key, ECDH P-256, and a 16-byte authentication secret: the inbox encrypts each notification
 *   to them (RFC 8291). The private half is kept sealed by SecureStore, for the push service, which
 *   decrypts while the app is closed.
 *
 * And the list of inboxes the push service may decrypt for, with the name it shows each under.
 */
public final class Keys {
  private static final String DEVICE_PREFIX = "sdi.device.";
  private static final String INBOXES = "sdi.inboxes";
  /** How long after the owner unlocks the phone (or the app) the device key may sign. */
  static final int AUTH_VALID_SECONDS = 300;
  private final Context context;
  private final SecureStore store;
  private final boolean userAuth;

  public Keys(Context context) {
    this(context, true);
  }

  /** `userAuth` false makes device keys that need no unlock: for the emulator's tests only. */
  Keys(Context context, boolean userAuth) {
    this.context = context.getApplicationContext();
    this.store = SecureStore.forPush(context);
    this.userAuth = userAuth;
  }

  /** The phone has a screen lock (a PIN, a pattern, a password): what every key here relies on. */
  public static boolean deviceSecure(Context context) {
    KeyguardManager km = context.getSystemService(KeyguardManager.class);
    return km != null && km.isDeviceSecure();
  }

  /** The device key may not sign until the owner unlocks: the app asks for the fingerprint and tries again. */
  public static final class AuthRequired extends Exception {
    AuthRequired() {
      super("Unlock to continue.");
    }
  }

  /** The screen lock was removed or changed in a way that ended the key: this inbox must be connected again. */
  public static final class KeyGone extends Exception {
    KeyGone() {
      super("This phone's lock changed: connect it again.");
    }
  }

  /** The phone has no screen lock: no key is made. */
  public static final class NoScreenLock extends Exception {
    NoScreenLock() {
      super("Set a screen lock on this phone first.");
    }
  }

  private static KeyStore keystore() throws Exception {
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    return ks;
  }

  /** The device key's public half, made on first use: x and y, base64url. */
  public String[] devicePublic(String alias) throws Exception {
    String name = DEVICE_PREFIX + alias;
    KeyStore ks = keystore();
    if (!ks.containsAlias(name)) {
      if (userAuth && !deviceSecure(context)) throw new NoScreenLock();
      KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
      KeyGenParameterSpec.Builder spec =
          new KeyGenParameterSpec.Builder(name, KeyProperties.PURPOSE_SIGN)
              .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
              .setDigests(KeyProperties.DIGEST_SHA256);
      if (userAuth) {
        spec.setUserAuthenticationRequired(true);
        // A new fingerprint enrolled does not end it: the screen lock still guards it.
        spec.setInvalidatedByBiometricEnrollment(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          spec.setUserAuthenticationParameters(
              AUTH_VALID_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        } else {
          spec.setUserAuthenticationValidityDurationSeconds(AUTH_VALID_SECONDS);
        }
      }
      g.initialize(spec.build());
      g.generateKeyPair();
    }
    ECPublicKey pub = (ECPublicKey) ks.getCertificate(name).getPublicKey();
    byte[] point = WebPushCrypto.uncompressed(pub);
    return new String[] {b64u(java.util.Arrays.copyOfRange(point, 1, 33)), b64u(java.util.Arrays.copyOfRange(point, 33, 65))};
  }

  /** A signature with the device key, raw r ‖ s, base64url. */
  public String sign(String alias, String data) throws Exception {
    KeyStore ks = keystore();
    PrivateKey key = (PrivateKey) ks.getKey(DEVICE_PREFIX + alias, null);
    if (key == null) throw new IllegalStateException("no device key for this inbox");
    Signature s = Signature.getInstance("SHA256withECDSA");
    try {
      s.initSign(key);
    } catch (UserNotAuthenticatedException e) {
      throw new AuthRequired();
    } catch (KeyPermanentlyInvalidatedException e) {
      throw new KeyGone();
    }
    s.update(data.getBytes(StandardCharsets.UTF_8));
    return b64u(WebPushCrypto.derToRaw(s.sign()));
  }

  /** The push key's public point and the authentication secret, made on first use. */
  public String[] pushPublic(String alias) throws Exception {
    byte[] point = store.get("push.pub." + alias);
    byte[] auth = store.get("push.auth." + alias);
    if (point == null || auth == null || store.get("push.priv." + alias) == null) {
      KeyPair pair = WebPushCrypto.generate();
      point = WebPushCrypto.uncompressed((ECPublicKey) pair.getPublic());
      auth = new byte[16];
      new SecureRandom().nextBytes(auth);
      store.put("push.priv." + alias, pair.getPrivate().getEncoded());
      store.put("push.pub." + alias, point);
      store.put("push.auth." + alias, auth);
    }
    return new String[] {b64u(point), b64u(auth)};
  }

  /** The plaintext of a notification, for whichever inbox's key opens it; null when none does. */
  public Decrypted decrypt(byte[] message) {
    return decrypt(message, null);
  }

  /**
   * The plaintext of a notification the relay names a device for (`d`): only that inbox's key is
   * tried when this phone knows the device; otherwise every inbox's, for one registered before the
   * phone was told its device.
   */
  public Decrypted decrypt(byte[] message, String device) {
    List<Inbox> all = inboxes();
    List<Inbox> tried = new ArrayList<>();
    if (device != null && !device.isEmpty()) {
      for (Inbox inbox : all) if (device.equals(inbox.device)) tried.add(inbox);
    }
    if (tried.isEmpty()) tried = all;
    for (Inbox inbox : tried) {
      try {
        byte[] priv = store.get("push.priv." + inbox.alias);
        byte[] pub = store.get("push.pub." + inbox.alias);
        byte[] auth = store.get("push.auth." + inbox.alias);
        if (priv == null || pub == null || auth == null) continue;
        PrivateKey key = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(priv));
        byte[] plain = WebPushCrypto.decrypt(message, key, pub, auth);
        return new Decrypted(inbox, new String(plain, StandardCharsets.UTF_8));
      } catch (Exception notThisOne) {
        // Not for this inbox: the next one.
      }
    }
    return null;
  }

  public void delete(String alias) {
    try {
      keystore().deleteEntry(DEVICE_PREFIX + alias);
    } catch (Exception ignored) {
      // gone already
    }
    store.remove("push.priv." + alias);
    store.remove("push.pub." + alias);
    store.remove("push.auth." + alias);
  }

  public static final class Inbox {
    public final String alias;
    public final String origin;
    public final String name;
    /** The relay's id for this phone at this inbox, once the inbox has said it; "" before. */
    public final String device;

    Inbox(String alias, String origin, String name, String device) {
      this.alias = alias;
      this.origin = origin;
      this.name = name;
      this.device = device;
    }
  }

  public static final class Decrypted {
    public final Inbox inbox;
    public final String json;

    Decrypted(Inbox inbox, String json) {
      this.inbox = inbox;
      this.json = json;
    }
  }

  private SharedPreferences prefs() {
    return context.getSharedPreferences("sdi.plain", Context.MODE_PRIVATE);
  }

  public void setInboxes(JSONArray list) {
    prefs().edit().putString(INBOXES, list.toString()).apply();
  }

  public List<Inbox> inboxes() {
    List<Inbox> out = new ArrayList<>();
    try {
      JSONArray a = new JSONArray(prefs().getString(INBOXES, "[]"));
      for (int i = 0; i < a.length(); i++) {
        JSONObject o = a.getJSONObject(i);
        out.add(
            new Inbox(o.getString("alias"), o.getString("origin"), o.optString("name", ""), o.optString("device", "")));
      }
    } catch (Exception ignored) {
      // none
    }
    return out;
  }

  public static String b64u(byte[] b) {
    return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
  }

  public static byte[] fromB64u(String s) {
    return Base64.decode(s, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
  }
}
