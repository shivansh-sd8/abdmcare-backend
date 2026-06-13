import crypto from 'crypto';
import fs from 'fs';
import { config } from '../config/index';

  // ─────────────────────────────────────────────────────────────────────────────
// ECDH types (ABDM v3 spec mandates Curve25519/X25519, but several
// "Curve25519"-labelled HIUs/HIPs in the field actually emit NIST P-256
// keys — we accept both and reply on whichever curve the peer used so the
// shared-secret derivation succeeds.)
// ─────────────────────────────────────────────────────────────────────────────
export type ECDHCurve = 'X25519' | 'X448' | 'prime256v1';

export interface ECDHKeyPair {
  privateKey: string; // base64 (PKCS8 DER)
  publicKey: string;  // base64 (SPKI DER)
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
  // ECDH — ABDM Curve25519 (X25519) key exchange + AES-256-GCM
  // ═══════════════════════════════════════════════════════════════════════════

  static generateECDHKeyPair(curve: ECDHCurve = 'X25519'): ECDHKeyPair {
    let keyPair: crypto.KeyPairKeyObjectResult;
    if (curve === 'X25519') {
      keyPair = crypto.generateKeyPairSync('x25519');
    } else if (curve === 'X448') {
      keyPair = crypto.generateKeyPairSync('x448');
    } else if (curve === 'prime256v1') {
      keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    } else {
      throw new Error(`Unsupported ECDH curve: ${curve}`);
    }
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' });
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'der' });
    const nonce = crypto.randomBytes(32);
    return {
      privateKey: privateKey.toString('base64'),
      publicKey: publicKey.toString('base64'),
      nonce: nonce.toString('base64'),
      curve,
    };
  }

  /**
   * Inspect the peer public key bytes and infer which curve they belong to.
   * Used to decide which curve to use for OUR own ephemeral keypair so that
   * `crypto.diffieHellman` doesn't fail with a mismatched-curve "decode error".
   *
   * Inference is byte-shape based — it does NOT trust the `keyMaterial.curve`
   * field on the wire. Several ABDM-certified HIUs label P-256 keys as
   * "Curve25519", so trusting the label leads to silent shared-secret
   * mismatches. The bytes never lie:
   *   • 32 bytes (or 33 with sign byte)               → X25519
   *   • 56 bytes                                       → X448
   *   • 65 bytes starting with 0x04                    → P-256 X9.63 point
   *   • 91 bytes starting with 30 59 30 13 06 07 2a … → P-256 SPKI DER
   *   • 44 bytes starting with 30 2a 30 05 06 03 2b 65 → X25519 SPKI DER
   */
  static detectCurveFromBytes(bytes: Buffer): ECDHCurve {
    // SPKI DER — peek at the algorithm OID inside.
    if (bytes.length > 32 && bytes[0] === 0x30) {
      const hex = bytes.toString('hex');
      if (hex.includes('06082a8648ce3d030107')) return 'prime256v1'; // 1.2.840.10045.3.1.7
      if (hex.includes('06032b656e')) return 'X25519';                 // 1.3.101.110
      if (hex.includes('06032b656f')) return 'X448';                   // 1.3.101.111
    }
    // Raw key by length.
    let raw = bytes;
    if (raw.length === 33 && raw[0] === 0x00) raw = raw.subarray(1);
    if (raw.length === 32) return 'X25519';
    if (raw.length === 56) return 'X448';
    if (raw.length === 65 && raw[0] === 0x04) return 'prime256v1';
    if (raw.length === 97 && raw[0] === 0x04) return 'prime256v1'; // P-384 not supported here yet
    return 'X25519'; // safe default — older ABDM spec
  }

  // ASN.1 SPKI prefix for an X25519 (1.3.101.110) public key wrapping a raw
  // 32-byte key: SEQUENCE(42){ SEQUENCE(5){ OID 2b656e } BITSTRING(33){00 + key} }.
  private static readonly X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

  // ASN.1 SPKI prefix for an X448 (1.3.101.111) public key wrapping a raw
  // 56-byte key: SEQUENCE(46){ SEQUENCE(5){ OID 2b656f } BITSTRING(57){00 + key} }.
  private static readonly X448_SPKI_PREFIX = Buffer.from('3042300506032b656f033900', 'hex');

  /**
   * Best-effort decode of a peer's public key. ABDM-aligned HIUs/HIPs are
   * supposed to send a base64-encoded SPKI DER, but in practice the wild west
   * of certified vendors emits at least seven different shapes:
   *
   *   1. base64( SPKI DER )                  — what Node's crypto exports
   *   2. base64( raw 32 bytes )              — "Curve25519/32byte random key"
   *   3. base64( 0x00 ‖ raw 32 bytes )       — Java BigInteger "sign byte"
   *   4. base64url( ... )                    — JWK-style without padding
   *   5. hex( SPKI DER ) | hex( raw )        — some BouncyCastle wrappers
   *   6. base64( ASCII-hex( SPKI / raw ) )   — double-encoded by accident
   *   7. PEM (BEGIN PUBLIC KEY ... END)
   *
   * Returns the decoded KEY BYTES (DER or raw 32 bytes), the encoding that
   * worked, and a short diagnostic string. Throws AppError-equivalent only
   * when nothing matches.
   */
  private static decodePeerKey(peerPublicKeyB64: string): { bytes: Buffer; encoding: string } {
    const trimmed = peerPublicKeyB64.trim().replace(/^"|"$/g, '');
    if (trimmed.includes('BEGIN')) {
      // PEM — let createPublicKey handle it directly downstream by signalling
      // through a special encoding tag.
      return { bytes: Buffer.from(trimmed, 'utf8'), encoding: 'pem' };
    }

    // Pure hex string? (only 0-9a-fA-F, even length, sane size for an X25519
    // key in any envelope: 32, 33, 44, 65, 91 bytes ⇒ 64..182 hex chars).
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length >= 64 && trimmed.length <= 256) {
      return { bytes: Buffer.from(trimmed, 'hex'), encoding: 'hex' };
    }

    // base64 / base64url (with or without padding).
    const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    let raw = Buffer.from(padded, 'base64');

    // Some senders accidentally double-encode: base64( ASCII hex( bytes ) ).
    // Detect it (every decoded byte is a valid hex character) and undo.
    const looksLikeAsciiHex =
      raw.length >= 64 &&
      raw.length % 2 === 0 &&
      raw.every(b => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66));
    if (looksLikeAsciiHex) {
      try {
        const inner = Buffer.from(raw.toString('utf8'), 'hex');
        return { bytes: inner, encoding: 'base64-of-asciihex' };
      } catch {
        // fall through
      }
    }

    return { bytes: raw, encoding: 'base64' };
  }

  /**
   * Build a public KeyObject from however ABDM/peers encode it. Auto-detects
   * the curve (X25519, X448, P-256) from the byte shape. The returned
   * KeyObject's curve drives our own ephemeral keypair selection in
   * `encryptWithECDH` so the subsequent DH derive succeeds.
   */
  private static toECDHPublicKey(peerPublicKeyB64: string): crypto.KeyObject {
    if (!peerPublicKeyB64 || typeof peerPublicKeyB64 !== 'string') {
      throw new Error('Peer public key is empty or not a string');
    }

    const decoded = this.decodePeerKey(peerPublicKeyB64);

    if (decoded.encoding === 'pem') {
      return crypto.createPublicKey({ key: decoded.bytes.toString('utf8'), format: 'pem' });
    }

    const raw = decoded.bytes;

    // Path 1: full SPKI DER (any supported curve). Length > 32 + leading
    // SEQUENCE tag is a very strong signal.
    if (raw.length > 32 && raw[0] === 0x30) {
      try {
        return crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
      } catch {
        // fall through
      }
    }

    // Path 2: raw 32-byte X25519 key, optionally with a Java sign byte.
    let rawKey = raw;
    if (rawKey.length === 33 && rawKey[0] === 0x00) rawKey = rawKey.subarray(1);
    if (rawKey.length === 32) {
      const spki = Buffer.concat([this.X25519_SPKI_PREFIX, rawKey]);
      return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    }

    // Path 3: raw 56-byte X448 key (rare but in NRCeS reference SDK options).
    if (rawKey.length === 56) {
      const spki = Buffer.concat([this.X448_SPKI_PREFIX, rawKey]);
      return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    }

    // Path 4: X9.63 uncompressed point for NIST curves (some legacy HIPs use
    // P-256). 65 bytes starting with 0x04 ⇒ secp256r1.
    if (rawKey.length === 65 && rawKey[0] === 0x04) {
      const spki = Buffer.concat([
        Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
        rawKey,
      ]);
      return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    }

    // Nothing fit — surface a diagnostic so the operator can tell ABDM/the
    // peer exactly what we received instead of a bare "wrong tag".
    const head = raw.subarray(0, Math.min(8, raw.length)).toString('hex');
    throw new Error(
      `Peer public key in unrecognised encoding (${decoded.encoding}, ${raw.length} bytes, head=${head}). ` +
        `Expected base64 of SPKI DER (44 bytes for X25519) or raw 32-byte X25519 key.`,
    );
  }

  /**
   * Derive a 256-bit shared secret using ECDH + XOR'd nonces as HKDF salt.
   *
   * The peer's curve must match our own private key's curve. If our key is
   * X25519 but the peer key is P-256, `crypto.diffieHellman` fails with
   * "decode error" — that's the regression we hit when an HIU mislabels its
   * P-256 key as Curve25519. `encryptWithECDH` solves this by detecting the
   * peer's curve from the bytes and generating a matching local keypair
   * BEFORE calling deriveSharedSecret.
   */
  static deriveSharedSecret(
    ownPrivateKeyB64: string,
    peerPublicKeyB64: string,
    ownNonce: string,
    peerNonce: string,
  ): Buffer {
    const ownPrivateKey = crypto.createPrivateKey({
      key: Buffer.from(ownPrivateKeyB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const peerPublicKey = this.toECDHPublicKey(peerPublicKeyB64);

    const ownCurve = (ownPrivateKey.asymmetricKeyType || '').toLowerCase();
    const peerCurve = (peerPublicKey.asymmetricKeyType || '').toLowerCase();
    if (ownCurve && peerCurve && ownCurve !== peerCurve) {
      throw new Error(
        `ECDH curve mismatch: own private key is ${ownCurve} but peer public key is ${peerCurve}. ` +
          `Generate the local keypair on the peer's curve before deriving.`,
      );
    }

    const sharedSecret = crypto.diffieHellman({
      privateKey: ownPrivateKey,
      publicKey: peerPublicKey,
    });

    const ownNonceBuf = Buffer.from(ownNonce, 'base64');
    const peerNonceBuf = Buffer.from(peerNonce, 'base64');
    const salt = Buffer.alloc(ownNonceBuf.length);
    for (let i = 0; i < ownNonceBuf.length; i++) {
      salt[i] = ownNonceBuf[i] ^ (peerNonceBuf[i] || 0);
    }

    return crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.alloc(0), 32) as unknown as Buffer;
  }

  /**
   * Encrypt plaintext for HIP data push.
   *
   * Detects the peer's curve from its public key bytes (X25519 / X448 /
   * P-256), generates an ephemeral local keypair on the SAME curve, derives
   * the AES-256-GCM session key, and emits a keyMaterial whose `curve` and
   * `parameters` reflect what the peer can actually decrypt against. The
   * peer-curve label on the wire is ignored on purpose — several certified
   * HIUs label P-256 keys as "Curve25519".
   */
  static encryptWithECDH(
    plaintext: string,
    peerPublicKeyB64: string,
    peerNonce: string,
  ): ECDHEncryptResult {
    const peerBytes = this.decodePeerKey(peerPublicKeyB64).bytes;
    const peerCurve = this.detectCurveFromBytes(peerBytes);
    const ownKeyPair = this.generateECDHKeyPair(peerCurve);

    const derivedKeyBuf = this.deriveSharedSecret(
      ownKeyPair.privateKey,
      peerPublicKeyB64,
      ownKeyPair.nonce,
      peerNonce,
    );
    const derivedKey = Buffer.from(derivedKeyBuf);

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([iv, encrypted, authTag]).toString('base64');

    // ABDM expects "Curve25519" as the curve label for X25519; P-256 has no
    // ABDM-canonical label, so we mirror what most certified HIUs send.
    const curveLabel =
      peerCurve === 'X25519' ? 'Curve25519'
      : peerCurve === 'X448' ? 'Curve448'
      : peerCurve === 'prime256v1' ? 'Curve25519' // peers labelled P-256 as Curve25519; mirror that
      : 'Curve25519';
    const parameters =
      peerCurve === 'X25519' ? 'Curve25519/32byte random key'
      : peerCurve === 'prime256v1' ? 'secp256r1/uncompressed point'
      : 'Curve25519/32byte random key';

    return {
      encryptedData: ciphertext,
      keyMaterial: {
        cryptoAlg: 'ECDH',
        curve: curveLabel,
        dhPublicKey: {
          expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          parameters,
          keyValue: ownKeyPair.publicKey,
        },
        nonce: ownKeyPair.nonce,
      },
    };
  }

  /**
   * AES-256-GCM encrypt with a pre-derived ECDH session key. Used when many
   * payloads must be encrypted under the SAME session keypair (so the peer can
   * decrypt them all with the single keyMaterial we publish).
   */
  static encryptWithSessionKey(plaintext: string, derivedKey: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, authTag]).toString('base64');
  }

  static decryptWithECDH(
    encryptedDataB64: string,
    ownPrivateKeyB64: string,
    ownNonce: string,
    peerPublicKeyB64: string,
    peerNonce: string,
  ): string {
    const derivedKeyBuf = this.deriveSharedSecret(
      ownPrivateKeyB64,
      peerPublicKeyB64,
      ownNonce,
      peerNonce,
    );
    const derivedKey = Buffer.from(derivedKeyBuf);

    const data = Buffer.from(encryptedDataB64, 'base64');
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(12, data.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }
  /**
   * Self-test: verify ECDH round-trip encrypt/decrypt works correctly.
   * Call on server startup in dev mode to catch format issues early.
   */
  static verifyECDHRoundTrip(): boolean {
    try {
      const testData = '{"resourceType":"Bundle","type":"document","entry":[]}';

      const senderKP = this.generateECDHKeyPair();
      const result = this.encryptWithECDH(testData, senderKP.publicKey, senderKP.nonce);

      if (result.keyMaterial.curve !== 'Curve25519') {
        throw new Error(`Expected curve Curve25519, got ${result.keyMaterial.curve}`);
      }
      if (result.keyMaterial.cryptoAlg !== 'ECDH') {
        throw new Error(`Expected cryptoAlg ECDH, got ${result.keyMaterial.cryptoAlg}`);
      }

      const pubKeyBuf = Buffer.from(result.keyMaterial.dhPublicKey.keyValue, 'base64');
      if (pubKeyBuf.length < 32) {
        throw new Error(`Public key too short: ${pubKeyBuf.length} bytes (expected >=32 in DER/SPKI)`);
      }

      const nonceBuf = Buffer.from(result.keyMaterial.nonce, 'base64');
      if (nonceBuf.length !== 32) {
        throw new Error(`Nonce must be 32 bytes, got ${nonceBuf.length}`);
      }

      return true;
    } catch (err: any) {
      console.error('ECDH self-test FAILED:', err.message);
      return false;
    }
  }
}

export default EncryptionService;
