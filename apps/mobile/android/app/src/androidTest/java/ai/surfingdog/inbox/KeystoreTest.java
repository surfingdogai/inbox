package ai.surfingdog.inbox;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Notification;
import android.content.Context;
import android.os.Bundle;
import android.security.keystore.KeyInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * On a real Android (the emulator in CI, with a PIN set so the phone counts as locked by a screen
 * lock): the Keystore-backed parts the JVM tests cannot reach. The device key signs and the inbox's
 * check (raw r ‖ s over its public x and y) accepts it, and the app's own device key signs only after
 * an unlock; secure storage keeps a value under its own name only, and moves an earlier build's; a
 * notification encrypted for this phone's push key is opened by the push service's own decrypter, for
 * the right inbox; a notification with a customer's name keeps it off a lock screen that hides
 * sensitive content; and an action's nonce works once, for its own item.
 */
@RunWith(AndroidJUnit4.class)
public class KeystoreTest {
  private Context context() {
    return InstrumentationRegistry.getInstrumentation().getTargetContext();
  }

  @Test
  public void secureStoreKeepsAValueUnderItsNameOnly() throws Exception {
    SecureStore s = SecureStore.forApp(context());
    s.putString("test.a", "sdi_pr_secret");
    assertEquals("sdi_pr_secret", s.getString("test.a"));
    assertNull(s.getString("test.b"));
    s.remove("test.a");
    assertNull(s.getString("test.a"));
    // An earlier build's value, kept in the push store, is moved over once.
    SecureStore older = SecureStore.forPush(context());
    older.putString("app.test.c", "sdi_pr_old");
    assertEquals("sdi_pr_old", s.takeOver(older, "app.test.c"));
    assertNull(older.getString("app.test.c"));
    assertEquals("sdi_pr_old", s.getString("app.test.c"));
    s.remove("app.test.c");
  }

  @Test
  public void theAppsDeviceKeyNeedsAnUnlockToSign() throws Exception {
    Keys keys = new Keys(context());
    String alias = "ib_auth_" + System.nanoTime();
    if (!Keys.deviceSecure(context())) {
      try {
        keys.devicePublic(alias);
        fail("a device key was made on a phone with no screen lock");
      } catch (Keys.NoScreenLock expected) {
        return;
      }
    }
    keys.devicePublic(alias);
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    PrivateKey key = (PrivateKey) ks.getKey("sdi.device." + alias, null);
    KeyInfo info = KeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore").getKeySpec(key, KeyInfo.class);
    assertTrue(info.isUserAuthenticationRequired());
    assertEquals(Keys.AUTH_VALID_SECONDS, info.getUserAuthenticationValidityDurationSeconds());
    try {
      keys.sign(alias, "surfingdog-inbox-phone/1\nrefresh\nhttps://inbox.example\nabc\n1");
      // Signed: the emulator was unlocked within the last five minutes, which is allowed.
    } catch (Keys.AuthRequired expected) {
      // Not unlocked lately: the app asks for the fingerprint and tries again.
    }
    keys.delete(alias);
  }

  @Test
  public void deviceKeySignsWhatTheInboxChecks() throws Exception {
    Keys keys = new Keys(context(), false);
    String alias = "ib_test_" + System.nanoTime();
    String[] xy = keys.devicePublic(alias);
    assertArrayEquals(xy, keys.devicePublic(alias)); // made once
    String statement = "surfingdog-inbox-phone/1\nrefresh\nhttps://inbox.example\nabc\n1";
    byte[] raw = Keys.fromB64u(keys.sign(alias, statement));
    assertEquals(64, raw.length);
    PublicKey pub =
        KeyFactory.getInstance("EC")
            .generatePublic(
                new ECPublicKeySpec(
                    new ECPoint(new BigInteger(1, Keys.fromB64u(xy[0])), new BigInteger(1, Keys.fromB64u(xy[1]))),
                    WebPushCrypto.p256()));
    Signature v = Signature.getInstance("SHA256withECDSA");
    v.initVerify(pub);
    v.update(statement.getBytes(StandardCharsets.UTF_8));
    assertTrue(v.verify(der(raw)));
    keys.delete(alias);
  }

  @Test
  public void opensANotificationEncryptedForThisPhone() throws Exception {
    Keys keys = new Keys(context(), false);
    String alias = "ib_push_" + System.nanoTime();
    JSONArray list =
        new JSONArray()
            .put(
                new JSONObject()
                    .put("alias", alias)
                    .put("origin", "https://inbox.example")
                    .put("name", "Atelier Lumen")
                    .put("device", "pd_this"));
    keys.setInboxes(list);
    String[] pub = keys.pushPublic(alias);
    byte[] message = encrypt(Keys.fromB64u(pub[0]), Keys.fromB64u(pub[1]), "{\"v\":1,\"title\":\"New booking request\"}");
    Keys.Decrypted d = keys.decrypt(message, "pd_this");
    assertNotNull(d);
    assertEquals(alias, d.inbox.alias);
    // Before the phone knows its device id, every inbox's key is tried.
    assertNotNull(keys.decrypt(message, "pd_not_known_yet"));
    assertTrue(d.json.contains("New booking request"));
    // Shown without throwing, whether or not notifications are allowed on the emulator.
    Notifier.channels(context());
    Notifier.show(context(), d.inbox, "{\"v\":1,\"t\":\"item\",\"item\":\"01J\",\"kind\":\"booking\",\"title\":\"New booking request\",\"body\":\"Tue, 14:00\",\"action\":{\"event\":\"confirm\",\"label\":\"Accept 14:00\"},\"at\":1}");
    // Another inbox's message is not opened.
    byte[] other = encrypt(WebPushCrypto.uncompressed((ECPublicKey) WebPushCrypto.generate().getPublic()), new byte[16], "x");
    assertNull(keys.decrypt(other));
    keys.delete(alias);
  }

  @Test
  public void keepsACustomersNameOffALockScreenThatHidesSensitiveContent() throws Exception {
    Keys.Inbox inbox = new Keys.Inbox("ib_n", "https://inbox.example", "Atelier Lumen", "pd_n");
    Notification minimal =
        Notifier.build(
            context(),
            inbox,
            "{\"v\":1,\"t\":\"item\",\"item\":\"01J\",\"kind\":\"booking\",\"title\":\"New booking request\",\"body\":\"Tue, 14:00 · Cut\",\"at\":1}");
    assertNotNull(minimal);
    assertEquals(Notification.VISIBILITY_PUBLIC, minimal.visibility);
    assertNull(minimal.publicVersion);

    Notification detailed =
        Notifier.build(
            context(),
            inbox,
            "{\"v\":1,\"t\":\"item\",\"item\":\"01K\",\"kind\":\"booking\",\"title\":\"New booking request\",\"body\":\"Tue, 14:00 · Cut\",\"who\":\"Maya Chen\",\"text\":\"Around 2pm if you can\",\"at\":2}");
    assertNotNull(detailed);
    assertEquals(Notification.VISIBILITY_PRIVATE, detailed.visibility);
    assertNotNull(detailed.publicVersion);
    Bundle shown = detailed.publicVersion.extras;
    String all =
        String.valueOf(shown.getCharSequence(Notification.EXTRA_TITLE))
            + String.valueOf(shown.getCharSequence(Notification.EXTRA_TEXT))
            + String.valueOf(shown.getCharSequence(Notification.EXTRA_BIG_TEXT));
    assertFalse(all.contains("Maya"));
    assertFalse(all.contains("2pm"));
    assertTrue(all.contains("New booking request"));
  }

  @Test
  public void anActionsNonceWorksOnceForItsOwnItem() {
    String nonce = Notifier.nonceFor(context(), "01J", "confirm");
    assertFalse(Notifier.claim(context(), nonce, "01X", "confirm"));
    // Spent by the wrong try: a link cannot probe for it.
    assertFalse(Notifier.claim(context(), nonce, "01J", "confirm"));
    String again = Notifier.nonceFor(context(), "01J", "confirm");
    assertTrue(Notifier.claim(context(), again, "01J", "confirm"));
    assertFalse(Notifier.claim(context(), again, "01J", "confirm"));
    assertFalse(Notifier.claim(context(), "", "01J", "confirm"));
  }

  /** The inbox's side, as packages/core/src/phones/crypto.ts writes it (RFC 8291, one record). */
  private static byte[] encrypt(byte[] uaPublic, byte[] auth, String text) throws Exception {
    KeyPair sender = WebPushCrypto.generate();
    byte[] asPublic = WebPushCrypto.uncompressed((ECPublicKey) sender.getPublic());
    byte[] salt = new byte[16];
    new SecureRandom().nextBytes(salt);
    KeyAgreement ka = KeyAgreement.getInstance("ECDH");
    ka.init(sender.getPrivate());
    ka.doPhase(WebPushCrypto.publicKey(uaPublic), true);
    byte[] secret = ka.generateSecret();
    byte[] prkKey = WebPushCrypto.hmac(auth, secret);
    byte[] info = WebPushCrypto.concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII), uaPublic, asPublic);
    byte[] ikm = WebPushCrypto.hmac(prkKey, WebPushCrypto.concat(info, new byte[] {1}));
    byte[] prk = WebPushCrypto.hmac(salt, ikm);
    byte[] cek = Arrays.copyOf(WebPushCrypto.hmac(prk, "Content-Encoding: aes128gcm\0\1".getBytes(StandardCharsets.US_ASCII)), 16);
    byte[] nonce = Arrays.copyOf(WebPushCrypto.hmac(prk, "Content-Encoding: nonce\0\1".getBytes(StandardCharsets.US_ASCII)), 12);
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
    byte[] record = c.doFinal(WebPushCrypto.concat(text.getBytes(StandardCharsets.UTF_8), new byte[] {2}));
    byte[] header = new byte[21 + 65];
    System.arraycopy(salt, 0, header, 0, 16);
    header[18] = 0x10; // record size 4096
    header[20] = 65;
    System.arraycopy(asPublic, 0, header, 21, 65);
    return WebPushCrypto.concat(header, record);
  }

  private static byte[] der(byte[] raw) {
    byte[] r = integer(Arrays.copyOfRange(raw, 0, 32));
    byte[] s = integer(Arrays.copyOfRange(raw, 32, 64));
    byte[] out = new byte[2 + r.length + s.length];
    out[0] = 0x30;
    out[1] = (byte) (r.length + s.length);
    System.arraycopy(r, 0, out, 2, r.length);
    System.arraycopy(s, 0, out, 2 + r.length, s.length);
    return out;
  }

  private static byte[] integer(byte[] v) {
    byte[] b = new BigInteger(1, v).toByteArray();
    byte[] out = new byte[2 + b.length];
    out[0] = 0x02;
    out[1] = (byte) b.length;
    System.arraycopy(b, 0, out, 2, b.length);
    return out;
  }
}
