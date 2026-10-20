package ai.surfingdog.inbox;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Secrets on the phone (ADR-026): each value encrypted with AES-GCM under a key that lives in the
 * Android Keystore and never leaves it, then kept in the app's private preferences. The app is
 * excluded from backups (AndroidManifest.xml): a Keystore key does not travel, so neither do these.
 *
 * Two stores, two keys:
 *
 * - {@link #forApp}: what the screens keep (the refresh tokens, the offline cache's key, the list of
 *   inboxes). Its key works only while the phone is unlocked (Android 9 and later): a locked phone,
 *   lost or taken, cannot open them, even by a process running as the app.
 * - {@link #forPush}: the private halves of the push keys. A notification arrives while the phone is
 *   locked and must be decrypted then, so this key has no such condition.
 */
public final class SecureStore {
  private static final String PUSH_KEY = "sdi.store.v1";
  private static final String PUSH_PREFS = "sdi.secure";
  private static final String APP_KEY = "sdi.store.app.v1";
  private static final String APP_PREFS = "sdi.secure.app";

  private final SharedPreferences prefs;
  private final String keyAlias;
  private final boolean whileUnlocked;

  private SecureStore(Context context, String prefsName, String keyAlias, boolean whileUnlocked) {
    this.prefs = context.getApplicationContext().getSharedPreferences(prefsName, Context.MODE_PRIVATE);
    this.keyAlias = keyAlias;
    this.whileUnlocked = whileUnlocked;
  }

  /** The screens' secrets: readable only while the phone is unlocked. */
  public static SecureStore forApp(Context context) {
    return new SecureStore(context, APP_PREFS, APP_KEY, true);
  }

  /** The push keys: readable while the phone is locked, as a notification arrives. */
  public static SecureStore forPush(Context context) {
    return new SecureStore(context, PUSH_PREFS, PUSH_KEY, false);
  }

  private SecretKey key() throws Exception {
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    KeyStore.Entry entry = ks.getEntry(keyAlias, null);
    if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    KeyGenParameterSpec.Builder spec =
        new KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256);
    if (whileUnlocked && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setUnlockedDeviceRequired(true);
    g.init(spec.build());
    return g.generateKey();
  }

  public synchronized void put(String name, byte[] value) throws Exception {
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.ENCRYPT_MODE, key());
    // The name is bound to the value: one secret cannot be swapped in for another.
    c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
    byte[] iv = c.getIV();
    byte[] ct = c.doFinal(value);
    byte[] out = ByteBuffer.allocate(1 + iv.length + ct.length).put((byte) iv.length).put(iv).put(ct).array();
    prefs.edit().putString(name, Base64.encodeToString(out, Base64.NO_WRAP)).apply();
  }

  public synchronized byte[] get(String name) {
    String stored = prefs.getString(name, null);
    if (stored == null) return null;
    try {
      byte[] all = Base64.decode(stored, Base64.NO_WRAP);
      int ivLen = all[0] & 0xff;
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 1, ivLen));
      c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
      return c.doFinal(all, 1 + ivLen, all.length - 1 - ivLen);
    } catch (Exception e) {
      // Unreadable (the Keystore key was reset, or the phone is locked): as if it was never kept.
      return null;
    }
  }

  public void putString(String name, String value) throws Exception {
    put(name, value.getBytes(StandardCharsets.UTF_8));
  }

  public String getString(String name) {
    byte[] v = get(name);
    return v == null ? null : new String(v, StandardCharsets.UTF_8);
  }

  public synchronized void remove(String name) {
    prefs.edit().remove(name).apply();
  }

  /**
   * Moves one value kept by an earlier build in the push store (the screens' values were once kept
   * there) into this one, once, and removes it from there.
   */
  public String takeOver(SecureStore older, String name) {
    String mine = getString(name);
    if (mine != null) return mine;
    String theirs = older.getString(name);
    if (theirs == null) return null;
    try {
      putString(name, theirs);
      older.remove(name);
    } catch (Exception keptWhereItWas) {
      // It stays where it was, and is read from there next time.
    }
    return theirs;
  }
}
