package ai.surfingdog.inbox;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Test;

/**
 * The phone's decrypter held to RFC 8291's own example, the same vector the inbox's encrypter is held
 * to (packages/spec/vectors/push.json): what one side writes, the other reads, byte for byte.
 */
public class WebPushCryptoTest {
  private static String vectors() throws Exception {
    // Gradle runs unit tests from the module (apps/mobile/android/app); the vector is the repo's.
    Path p = Paths.get("../../../../packages/spec/vectors/push.json");
    return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
  }

  private static String field(String json, String name) {
    Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*\"([^\"]+)\"").matcher(json);
    if (!m.find()) throw new AssertionError("no " + name + " in push.json");
    return m.group(1);
  }

  private static byte[] b64u(String s) {
    return Base64.getUrlDecoder().decode(s);
  }

  @Test
  public void decryptsTheRfcMessage() throws Exception {
    String v = vectors();
    byte[] plain =
        WebPushCrypto.decrypt(
            b64u(field(v, "message")),
            WebPushCrypto.privateKey(b64u(field(v, "ua_private"))),
            b64u(field(v, "ua_public")),
            b64u(field(v, "auth_secret")));
    assertEquals("When I grow up, I want to be a watermelon", new String(plain, StandardCharsets.UTF_8));
  }

  @Test
  public void refusesAMessageForAnotherPhone() throws Exception {
    String v = vectors();
    KeyPair other = WebPushCrypto.generate();
    try {
      WebPushCrypto.decrypt(
          b64u(field(v, "message")),
          other.getPrivate(),
          WebPushCrypto.uncompressed((ECPublicKey) other.getPublic()),
          b64u(field(v, "auth_secret")));
      fail("decrypted with another phone's key");
    } catch (GeneralSecurityException expected) {
      // the tag does not match: not for this phone
    }
  }

  @Test
  public void writesItsPublicKeyAsTheInboxReadsIt() throws Exception {
    KeyPair pair = WebPushCrypto.generate();
    byte[] point = WebPushCrypto.uncompressed((ECPublicKey) pair.getPublic());
    assertEquals(65, point.length);
    assertEquals(4, point[0]);
    assertArrayEquals(point, WebPushCrypto.uncompressed((ECPublicKey) WebPushCrypto.publicKey(point)));
  }

  @Test
  public void turnsADerSignatureIntoRawRAndS() throws Exception {
    KeyPair pair = WebPushCrypto.generate();
    byte[] data = "surfingdog-inbox-phone/1\nrefresh\nhttps://inbox.example\nabc\n1".getBytes(StandardCharsets.UTF_8);
    Signature s = Signature.getInstance("SHA256withECDSA");
    s.initSign(pair.getPrivate());
    s.update(data);
    byte[] raw = WebPushCrypto.derToRaw(s.sign());
    assertEquals(64, raw.length);
    // Back to DER, it verifies: nothing was lost on the way.
    Signature check = Signature.getInstance("SHA256withECDSA");
    check.initVerify(pair.getPublic());
    check.update(data);
    assertTrue(check.verify(rawToDer(raw)));
  }

  private static byte[] rawToDer(byte[] raw) {
    byte[] r = integer(java.util.Arrays.copyOfRange(raw, 0, 32));
    byte[] s = integer(java.util.Arrays.copyOfRange(raw, 32, 64));
    byte[] out = new byte[2 + r.length + s.length];
    out[0] = 0x30;
    out[1] = (byte) (r.length + s.length);
    System.arraycopy(r, 0, out, 2, r.length);
    System.arraycopy(s, 0, out, 2 + r.length, s.length);
    return out;
  }

  private static byte[] integer(byte[] v) {
    byte[] b = new java.math.BigInteger(1, v).toByteArray();
    byte[] out = new byte[2 + b.length];
    out[0] = 0x02;
    out[1] = (byte) b.length;
    System.arraycopy(b, 0, out, 2, b.length);
    return out;
  }
}
