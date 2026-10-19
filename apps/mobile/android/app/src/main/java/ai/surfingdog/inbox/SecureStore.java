package ai.surfingdog.inbox;

import android.content.Context;
import android.content.SharedPreferences;
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
 * Android Keystore and never leaves it, then kept in the app's private preferences. The refresh
 * tokens, the offline cache's key and the private halves of the push keys are kept here. The app is
 * excluded from backups (AndroidManifest.xml): a Keystore key does not travel, so neither do these.
 */
public final class SecureStore {
  private static final String KEY_ALIAS = "sdi.store.v1";
  private static final String PREFS = "sdi.secure";
  private final SharedPreferences prefs;

  public SecureStore(Context context) {
    this.prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static SecretKey key() throws Exception {
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
    if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    g.init(
        new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
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
      // Unreadable (the Keystore key was reset): as if it was never kept.
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
}
