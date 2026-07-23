import crypto from 'crypto';
import fs from 'fs';
import { weierstrass } from '@noble/curves/abstract/weierstrass';
import { Field } from '@noble/curves/abstract/modular';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { config } from '../config/index';

// ─────────────────────────────────────────────────────────────────────────────
// ECDH types — ABDM/NRCeS uses BouncyCastle's "curve25519" registered name,
// which is the WEIERSTRASS-FORM representation of Curve25519, NOT the
// standard RFC 7748 Montgomery-form X25519. Public keys are 65-byte
// uncompressed points (`04 || X(32) || Y(32)`); the OpenSSL/Node.js native
// X25519 only supports the 32-byte Montgomery form, which is why every
// previous attempt at native-only ECDH failed with "decode error". We use
// `@noble/curves` to implement the BC curve25519 Weierstrass curve directly.
// Reference: github.com/mgrmtech/fidelius-cli (Fidelius CLI, the canonical
// ABDM reference implementation).
// ─────────────────────────────────────────────────────────────────────────────
export type ECDHCurve = 'BC_curve25519';

export interface ECDHKeyPair {
  privateKey: string; // base64 of raw scalar (BigInteger.toByteArray() form)
  publicKey: string;  // base64 of 65-byte uncompressed point (04 || X || Y)
  x509PublicKey?: string; // base64 of X.509 SPKI DER for the same point
  nonce: string;      // base64 (32 random bytes)
  curve: ECDHCurve;
}

export interface ECDHKeyMaterial {
  cryptoAlg: string;
  curve: string;
  dhPublicKey: { expiry: string; parameters: string; keyValue: string };
  nonce: string;
}

export interface ECDHEncryptResult {
  encryptedData: string;  // base64 ciphertext
  keyMaterial: ECDHKeyMaterial;
}

export class EncryptionService {
  private static rsaPublicKey: string | null = null;
  private static rsaPrivateKey: string | null = null;

  static loadRSAKeys(): void {
    try {
      if (fs.existsSync(config.encryption.rsaPublicKeyPath)) {
        this.rsaPublicKey = fs.readFileSync(config.encryption.rsaPublicKeyPath, 'utf8');
      }
      if (fs.existsSync(config.encryption.rsaPrivateKeyPath)) {
        this.rsaPrivateKey = fs.readFileSync(config.encryption.rsaPrivateKeyPath, 'utf8');
      }
    } catch (error) {
      console.warn('RSA keys not found. Will fetch from ABDM when needed.');
    }
  }

  static setPublicKey(key: string): void {
    this.rsaPublicKey = key;
  }

  static encryptWithRSA(data: string, publicKey?: string): string {
    const keyToUse = publicKey || this.rsaPublicKey;
    if (!keyToUse) {
      throw new Error('RSA public key not available');
    }

    const buffer = Buffer.from(data, 'utf8');
    const encrypted = crypto.publicEncrypt(
      {
        key: keyToUse,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      buffer
    );

    return encrypted.toString('base64');
  }

  static decryptWithRSA(encryptedData: string, privateKey?: string): string {
    const keyToUse = privateKey || this.rsaPrivateKey;
    if (!keyToUse) {
      throw new Error('RSA private key not available');
    }

    const buffer = Buffer.from(encryptedData, 'base64');
    const decrypted = crypto.privateDecrypt(
      {
        key: keyToUse,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      buffer
    );

    return decrypted.toString('utf8');
  }

  static encryptWithAES(data: string, key?: string): { encrypted: string; iv: string } {
    const encryptionKey = key || config.encryption.aesKey;
    if (!encryptionKey || encryptionKey.length !== 32) {
      throw new Error('AES key must be 32 characters');
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey), iv);

    let encrypted = cipher.update(data, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return {
      encrypted,
      iv: iv.toString('base64'),
    };
  }

  static decryptWithAES(encryptedData: string, iv: string, key?: string): string {
    const encryptionKey = key || config.encryption.aesKey;
    if (!encryptionKey || encryptionKey.length !== 32) {
      throw new Error('AES key must be 32 characters');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(encryptionKey),
      Buffer.from(iv, 'base64')
    );

    let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  static generateHash(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  static generateRandomString(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ECDH — ABDM/Fidelius BouncyCastle "curve25519" Weierstrass form
  //
  // BC's "curve25519" is the CUSTOM Weierstrass-form representation of
  // Curve25519 (NOT RFC 7748 Montgomery-form X25519). The curve equation is
  // y² = x³ + a·x + b mod p, with parameters from BC's
  // `org.bouncycastle.math.ec.custom.djb.Curve25519`:
  //
  //   p = 2²⁵⁵ − 19
  //   a = 2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA984914A144 (hex)
  //   b = 7B425ED097B425ED097B425ED097B425ED097B425ED097B4260B5E9C7710C864 (hex)
  //   n (order) = 1000000000000000000000000000000014DEF9DEA2F79CD65812631A5CF5D3ED
  //   h (cofactor) = 8
  //   G = 04 || 2AAA…AD245A || 20AE19A1B8A086B4E01EDD2C7748D14C923D4D7E6D7C61B229E9C5A27ECED3D9
  //
  // Public keys: 65-byte uncompressed point `04 || X(32) || Y(32)`
  // Private keys: raw scalar bytes (Java BigInteger.toByteArray() form,
  //   may include a leading 0x00 sign byte)
  // ═══════════════════════════════════════════════════════════════════════════

  /** BC `curve25519` Weierstrass curve, modelled with @noble/curves. */
  private static readonly bcCurve25519 = (() => {
    const p = BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFED');
    const a = BigInt('0x2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA984914A144');
    const b = BigInt('0x7B425ED097B425ED097B425ED097B425ED097B425ED097B4260B5E9C7710C864');
    const n = BigInt('0x1000000000000000000000000000000014DEF9DEA2F79CD65812631A5CF5D3ED');
    const Gx = BigInt('0x2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD245A');
    const Gy = BigInt('0x20AE19A1B8A086B4E01EDD2C7748D14C923D4D7E6D7C61B229E9C5A27ECED3D9');
    return weierstrass({
      a,
      b,
      Fp: Field(p),
      n,
      Gx,
      Gy,
      h: BigInt(8),
      hash: sha256,
      hmac: (_key: Uint8Array, ..._msgs: Uint8Array[]) => new Uint8Array(),
      randomBytes: (len?: number) => Uint8Array.from(crypto.randomBytes(len ?? 32)),
      lowS: false,
      // BC/Fidelius compat: use raw scalar multiplication, no cofactor
      // clearing or torsion checks. Fidelius doesn't validate either.
      isTorsionFree: () => true,
      clearCofactor: (_c, p) => p,
    });
  })();

  /**
   * Strip Java's BigInteger sign byte (the leading 0x00 prepended when the
   * scalar's high bit would otherwise mark it as negative). Fidelius CLI's
   * `getEncoded(false).getEncoded()` for the public key always emits 65
   * bytes; for the private key it emits 32 OR 33 bytes (Java BigInteger).
   */
  private static stripSignByte(b: Uint8Array): Uint8Array {
    if (b.length === 33 && b[0] === 0x00) return b.subarray(1);
    return b;
  }

  /** Pad a scalar to 32 bytes (zero-extend on the left) for noble. */
  private static padScalar32(b: Uint8Array): Uint8Array {
    if (b.length === 32) return b;
    if (b.length > 32) return b.subarray(b.length - 32);
    const out = new Uint8Array(32);
    out.set(b, 32 - b.length);
    return out;
  }

  /**
   * Generate a fresh ECDH keypair on BC's `curve25519`. Output formats match
   * Fidelius CLI's KeyMaterial:
   *   privateKey  — base64 of the 32-byte scalar (no sign byte)
   *   publicKey   — base64 of the 65-byte uncompressed point `04||X||Y`
   *   x509PublicKey — base64 of the X.509 SPKI DER for the same point
   *   nonce       — base64 of 32 random bytes
   */
  static generateECDHKeyPair(_curve: ECDHCurve = 'BC_curve25519'): ECDHKeyPair {
    const priv = this.bcCurve25519.utils.randomPrivateKey();
    const pub = this.bcCurve25519.getPublicKey(priv, false); // false = uncompressed
    const nonce = crypto.randomBytes(32);
    return {
      privateKey: Buffer.from(priv).toString('base64'),
      publicKey: Buffer.from(pub).toString('base64'),
      x509PublicKey: this.encodeBcCurve25519AsSpki(pub).toString('base64'),
      nonce: nonce.toString('base64'),
      curve: 'BC_curve25519',
    };
  }

  /**
   * Wrap a BC `curve25519` uncompressed point in an X.509 SPKI DER envelope.
   * The HIU side parses this with
   *
   *   PublicKeyFactory.createKey(decodedKey)        // BouncyCastle
   *   KeyFactory.getInstance("EC")
   *            .generatePublic(new X509EncodedKeySpec(decodedKey))
   *
   * which strictly expects this structure AND validates that (X, Y) lies on
   * the curve indicated by the AlgorithmIdentifier OID (we observed
   * `ABDM-9999: encoded key spec not recognized  Invalid point coordinates`
   * when the OID disagreed with the actual curve).
   *
   * Wire layout (93 bytes total for a 65-byte uncompressed point):
   *
   *   30 5B                                    SEQUENCE 91 — SubjectPublicKeyInfo
   *     30 15                                  SEQUENCE 21 — AlgorithmIdentifier
   *       06 07 2A 86 48 CE 3D 02 01           OID 1.2.840.10045.2.1 (id-ecPublicKey)
   *       06 0A 2B 06 01 04 01 97 55 01 05 01  OID 1.3.6.1.4.1.3029.1.5.1 (BC curve25519)
   *     03 42 00 04 ||X(32)||Y(32)             BIT STRING 66 bytes
   *
   * Why this exact curve OID: BouncyCastle registers Weierstrass-form
   * curve25519 under OID `1.3.6.1.4.1.3029.1.5.1` in `ECNamedCurveTable`. The
   * receiver uses the OID to look up the curve parameters and then verifies
   * that (X, Y) satisfies `y² = x³ + a·x + b mod p` for THAT curve. Sending
   * a curve25519 point with a secp256k1 OID (as Fidelius CLI famously does)
   * passes some lenient validators but is rejected as "Invalid point
   * coordinates" by strict ones — including the production ABDM HIU sandbox.
   *
   * Multi-byte OID-arc encoding for 3029:
   *   3029 = 0b101111010101 (12 bits)
   *   high 5 bits = 0b00010111 = 0x17  → with cont. bit set → 0x97
   *   low  7 bits = 0b01010101 = 0x55
   *   → 0x97 0x55
   *
   * Lengths use canonical DER short form everywhere (each subcomponent < 128).
   */
  private static encodeBcCurve25519AsSpki(uncompressedPoint: Uint8Array): Buffer {
    if (uncompressedPoint.length !== 65 || uncompressedPoint[0] !== 0x04) {
      throw new Error('encodeBcCurve25519AsSpki expects a 65-byte uncompressed EC point starting with 0x04');
    }
    const idEcPublicKey = Buffer.from('06072a8648ce3d0201', 'hex');             // 1.2.840.10045.2.1 (id-ecPublicKey)
    const curveOid = Buffer.from('060a2b060104019755010501', 'hex');            // 1.3.6.1.4.1.3029.1.5.1 (BC curve25519)
    const algoBody = Buffer.concat([idEcPublicKey, curveOid]);                  // 9 + 12 = 21 bytes
    const algoSeq = Buffer.concat([Buffer.from([0x30, algoBody.length]), algoBody]); // 23 bytes

    const bitStringBody = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from(uncompressedPoint),
    ]); // 1 + 65 = 66 bytes
    const bitString = Buffer.concat([
      Buffer.from([0x03, bitStringBody.length]),
      bitStringBody,
    ]); // 2 + 66 = 68 bytes

    const inner = Buffer.concat([algoSeq, bitString]); // 23 + 68 = 91 bytes
    const outer = Buffer.concat([Buffer.from([0x30, inner.length]), inner]); // 2 + 91 = 93 bytes
    return outer;
  }

  /**
   * Pull the 65-byte uncompressed point out of however the peer sent it:
   *   • 65 bytes starting with `0x04`              → raw uncompressed point
   *   • SPKI DER (any length, leading `0x30`)      → look for the BIT STRING
   *     and take the last 65 bytes after the 0x00 unused-bits marker
   *   • base64 of the above, with possible padding/whitespace/quotes
   *   • hex of the above
   */
  private static decodePeerPoint(peerPublicKeyB64: string): { point: Uint8Array; encoding: string } {
    const trimmed = peerPublicKeyB64.trim().replace(/^"|"$/g, '');

    // Hex string
    let raw: Buffer;
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length >= 130) {
      raw = Buffer.from(trimmed, 'hex');
    } else {
      const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
      const padded = b64 + '==='.slice((b64.length + 3) % 4);
      raw = Buffer.from(padded, 'base64');
    }

    // Raw uncompressed point — `04 || X(32) || Y(32)`.
    if (raw.length === 65 && raw[0] === 0x04) {
      return { point: Uint8Array.from(raw), encoding: 'raw-uncompressed' };
    }

    // SPKI DER: scan for the trailing 65-byte uncompressed point. The BIT
    // STRING wraps `00 || 04 || X || Y`; the last 65 bytes of any well-formed
    // SPKI for an EC public key end with that pattern.
    if (raw[0] === 0x30 && raw.length > 65) {
      const tail = raw.subarray(raw.length - 65);
      if (tail[0] === 0x04) {
        return { point: Uint8Array.from(tail), encoding: 'spki' };
      }
    }

    // Compressed point — `02|03 || X(32)`. Decompress via the curve so we
    // get back to uncompressed form for ECDH.
    if (raw.length === 33 && (raw[0] === 0x02 || raw[0] === 0x03)) {
      const decoded = this.bcCurve25519.ProjectivePoint.fromHex(raw).toRawBytes(false);
      return { point: decoded, encoding: 'compressed' };
    }

    const head = raw.subarray(0, Math.min(8, raw.length)).toString('hex');
    throw new Error(
      `Peer public key in unrecognised encoding (${raw.length} bytes, head=${head}). ` +
        `Expected base64 of 65-byte uncompressed point (04||X||Y) or X.509 SPKI DER.`,
    );
  }

  /** Backwards-compat shim — returns just the bytes for diagnostic logging. */
  static decodePeerKeyForDiagnostics(peerPublicKeyB64: string): Buffer {
    try {
      const { point } = this.decodePeerPoint(peerPublicKeyB64);
      return Buffer.from(point);
    } catch {
      try {
        const trimmed = peerPublicKeyB64.trim().replace(/^"|"$/g, '');
        const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
        const padded = b64 + '==='.slice((b64.length + 3) % 4);
        return Buffer.from(padded, 'base64');
      } catch {
        return Buffer.alloc(0);
      }
    }
  }

  /**
   * Derive the AES-256-GCM session key per the Fidelius spec:
   *   1. xor = senderNonce ⊕ requesterNonce  (length = sender's, with cyclic indexing)
   *   2. SALT = first 20 bytes of xor
   *   3. IV   = last 12 bytes of xor (returned via a separate accessor, see below)
   *   4. shared = ECDH(senderPriv, requesterPub).x  → big-endian X coordinate of the shared point
   *   5. sessionKey = HKDF-SHA256(ikm = shared, salt = SALT, info = empty, len = 32)
   */
  static deriveSharedSecret(
    ownPrivateKeyB64: string,
    peerPublicKeyB64: string,
    ownNonce: string,
    peerNonce: string,
  ): Buffer {
    const { sessionKey } = this.deriveSession(ownPrivateKeyB64, peerPublicKeyB64, ownNonce, peerNonce);
    return sessionKey;
  }

  /** Returns both the AES key and the deterministic IV per Fidelius. */
  static deriveSession(
    ownPrivateKeyB64: string,
    peerPublicKeyB64: string,
    ownNonce: string,
    peerNonce: string,
  ): { sessionKey: Buffer; iv: Buffer; sharedSecret: Buffer } {
    const ownPrivRaw = this.padScalar32(this.stripSignByte(Uint8Array.from(Buffer.from(ownPrivateKeyB64, 'base64'))));
    const peerPoint = this.decodePeerPoint(peerPublicKeyB64).point;

    // ECDH on BC curve25519: scalar-multiply peer point by our scalar, take X.
    const sharedPoint = this.bcCurve25519.ProjectivePoint.fromHex(peerPoint).multiply(
      this.bcCurve25519.utils.normPrivateKeyToScalar(ownPrivRaw),
    );
    const sharedX = sharedPoint.toAffine().x;
    // Big-endian, fixed 32 bytes (Fidelius re-base64s sharedSecret bytes; the
    // scalar X is the input KeyMaterial for HKDF).
    const sharedSecret = Buffer.from(this.bigintToBytes32(sharedX));

    // SALT = first 20 bytes of XOR'd nonces (sender ⊕ requester, cyclic).
    const senderNonce = Buffer.from(ownNonce, 'base64');
    const requesterNonce = Buffer.from(peerNonce, 'base64');
    const xor = Buffer.alloc(senderNonce.length);
    for (let i = 0; i < senderNonce.length; i++) {
      xor[i] = senderNonce[i] ^ requesterNonce[i % requesterNonce.length];
    }
    const salt = xor.subarray(0, 20);
    const iv = xor.subarray(xor.length - 12);

    const sessionKey = Buffer.from(hkdf(sha256, sharedSecret, salt, undefined, 32));
    return { sessionKey, iv, sharedSecret };
  }

  private static bigintToBytes32(n: bigint): Uint8Array {
    const out = new Uint8Array(32);
    let v = n;
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  /**
   * Encrypt plaintext for the HIP→HIU push.
   *
   * Per Fidelius:
   *   • Generate fresh BC curve25519 keypair (sender keys)
   *   • Derive sessionKey + IV (deterministic, from XOR'd nonces)
   *   • AES-256-GCM (with 128-bit tag, per BC's GCMBlockCipher default)
   *   • Output: base64(ciphertext + tag) — NO IV prefix (peer recomputes IV)
   *   • keyMaterial: curve "Curve25519", parameters identifying the format,
   *     keyValue = base64 of 65-byte uncompressed point.
   */
  static encryptWithECDH(
    plaintext: string,
    peerPublicKeyB64: string,
    peerNonce: string,
  ): ECDHEncryptResult {
    const ownKeyPair = this.generateECDHKeyPair();
    const { sessionKey, iv } = this.deriveSession(
      ownKeyPair.privateKey,
      peerPublicKeyB64,
      ownKeyPair.nonce,
      peerNonce,
    );

    const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Fidelius emits ciphertext||tag (no IV prefix); the peer derives the IV
    // from the same nonce XOR.
    const ciphertext = Buffer.concat([encrypted, authTag]).toString('base64');

    return {
      encryptedData: ciphertext,
      keyMaterial: {
        cryptoAlg: 'ECDH',
        curve: 'Curve25519',
        dhPublicKey: {
          expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          parameters: 'Curve25519/32byte random key',
          keyValue: ownKeyPair.publicKey,
        },
        nonce: ownKeyPair.nonce,
      },
    };
  }

  /** AES-256-GCM encrypt with a pre-derived session key + deterministic IV. */
  static encryptWithSessionKey(plaintext: string, derivedKey: Buffer, iv?: Buffer): string {
    const useIv = iv || crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, useIv, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Fidelius format: NO IV prefix; the peer recomputes IV from the nonce XOR.
    return Buffer.concat([encrypted, authTag]).toString('base64');
  }

  static decryptWithECDH(
    encryptedDataB64: string,
    ownPrivateKeyB64: string,
    ownNonce: string,
    peerPublicKeyB64: string,
    peerNonce: string,
  ): string {
    const { sessionKey, iv } = this.deriveSession(
      ownPrivateKeyB64,
      peerPublicKeyB64,
      ownNonce,
      peerNonce,
    );

    const data = Buffer.from(encryptedDataB64, 'base64');
    const authTag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }

  /** Curve detection for diagnostics — always returns the BC curve now. */
  static detectCurveFromBytes(_bytes: Buffer): ECDHCurve {
    return 'BC_curve25519';
  }

  /** Self-test: round-trip encrypt/decrypt against a fresh peer keypair. */
  static verifyECDHRoundTrip(): boolean {
    try {
      const testData = '{"resourceType":"Bundle","type":"document","entry":[]}';
      const peer = this.generateECDHKeyPair();
      const result = this.encryptWithECDH(testData, peer.publicKey, peer.nonce);

      const decrypted = this.decryptWithECDH(
        result.encryptedData,
        peer.privateKey,
        peer.nonce,
        result.keyMaterial.dhPublicKey.keyValue,
        result.keyMaterial.nonce,
      );
      if (decrypted !== testData) throw new Error('Round-trip ciphertext mismatch');
      return true;
    } catch (err: any) {
      console.error('ECDH self-test FAILED:', err.message);
      return false;
    }
  }
}

export default EncryptionService;
