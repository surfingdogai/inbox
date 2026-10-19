package ai.surfingdog.inbox;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Decrypts a notification the inbox encrypted for this phone (ADR-026): Web Push message encryption,
 * RFC 8291, with the aes128gcm content coding of RFC 8188. Plain JVM cryptography, no Android: the
 * same class runs in the phone's push service and in the JVM tests, which hold it to the RFC's own
 * example (packages/spec/vectors/push.json).
 */
public final class WebPushCrypto {
  private WebPushCrypto() {}

  /** The curve's parameters, P-256. */
  public static ECParameterSpec p256() throws GeneralSecurityException {
    AlgorithmParameters params = AlgorithmParameters.getInstance("EC");
    params.init(new ECGenParameterSpec("secp256r1"));
    return params.getParameterSpec(ECParameterSpec.class);
  }

  /** A fresh ECDH key pair on P-256: the phone's push key for one inbox. */
  public static KeyPair generate() throws GeneralSecurityException {
    KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
    g.initialize(new ECGenParameterSpec("secp256r1"));
    return g.generateKeyPair();
  }

  /** 0x04 ‖ x ‖ y, 65 bytes. */
  public static byte[] uncompressed(ECPublicKey key) {
    byte[] out = new byte[65];
    out[0] = 4;
    copyUnsigned(key.getW().getAffineX(), out, 1);
    copyUnsigned(key.getW().getAffineY(), out, 33);
    return out;
  }

  public static PublicKey publicKey(byte[] point) throws GeneralSecurityException {
    if (point.length != 65 || point[0] != 4) throw new GeneralSecurityException("not an uncompressed P-256 point");
    BigInteger x = new BigInteger(1, Arrays.copyOfRange(point, 1, 33));
    BigInteger y = new BigInteger(1, Arrays.copyOfRange(point, 33, 65));
    return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), p256()));
  }

  public static PrivateKey privateKey(byte[] d) throws GeneralSecurityException {
    return KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, d), p256()));
  }

  /**
   * The plaintext of `message` (header and one record), for the phone whose private key, public point
   * and authentication secret are given. Throws when it was not made for this phone.
   */
  public static byte[] decrypt(byte[] message, PrivateKey phonePrivate, byte[] phonePublic, byte[] auth)
      throws GeneralSecurityException {
    if (message.length < 21 + 65 + 17) throw new GeneralSecurityException("too short");
    byte[] salt = Arrays.copyOfRange(message, 0, 16);
    int idlen = message[20] & 0xff;
    if (idlen != 65) throw new GeneralSecurityException("the sender key is not a P-256 point");
    byte[] senderPublic = Arrays.copyOfRange(message, 21, 21 + idlen);
    byte[] body = Arrays.copyOfRange(message, 21 + idlen, message.length);

    KeyAgreement ka = KeyAgreement.getInstance("ECDH");
    ka.init(phonePrivate);
    ka.doPhase(publicKey(senderPublic), true);
    byte[] ecdhSecret = ka.generateSecret();

    // RFC 8291 §3.3-3.4.
    byte[] prkKey = hmac(auth, ecdhSecret);
    byte[] keyInfo = concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII), phonePublic, senderPublic);
    byte[] ikm = hmac(prkKey, concat(keyInfo, new byte[] {1}));
    // RFC 8188 §2.2-2.3.
    byte[] prk = hmac(salt, ikm);
    byte[] cek = Arrays.copyOf(hmac(prk, "Content-Encoding: aes128gcm\0\1".getBytes(StandardCharsets.US_ASCII)), 16);
    byte[] nonce = Arrays.copyOf(hmac(prk, "Content-Encoding: nonce\0\1".getBytes(StandardCharsets.US_ASCII)), 12);

    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
    byte[] padded = c.doFinal(body);
    int end = padded.length - 1;
    while (end >= 0 && padded[end] == 0) end--;
    if (end < 0 || padded[end] != 2) throw new GeneralSecurityException("no last-record delimiter");
    return Arrays.copyOf(padded, end);
  }

  public static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(data);
  }

  public static byte[] concat(byte[]... parts) {
    int n = 0;
    for (byte[] p : parts) n += p.length;
    ByteBuffer b = ByteBuffer.allocate(n);
    for (byte[] p : parts) b.put(p);
    return b.array();
  }

  private static void copyUnsigned(BigInteger v, byte[] out, int at) {
    byte[] raw = v.toByteArray();
    int len = Math.min(raw.length, 32);
    System.arraycopy(raw, raw.length - len, out, at + 32 - len, len);
  }

  /** ECDSA's DER signature as the raw r ‖ s (64 bytes) the inbox checks with Web Crypto. */
  public static byte[] derToRaw(byte[] der) throws GeneralSecurityException {
    int i = 0;
    if (der[i++] != 0x30) throw new GeneralSecurityException("not a DER sequence");
    int seqLen = der[i++] & 0xff;
    if (seqLen > 0x80) i += seqLen - 0x80;
    byte[] out = new byte[64];
    for (int k = 0; k < 2; k++) {
      if (der[i++] != 0x02) throw new GeneralSecurityException("not a DER integer");
      int len = der[i++] & 0xff;
      byte[] v = Arrays.copyOfRange(der, i, i + len);
      i += len;
      copyUnsigned(new BigInteger(1, v), out, k * 32);
    }
    return out;
  }
}
