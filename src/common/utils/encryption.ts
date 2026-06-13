import crypto from 'crypto';
import fs from 'fs';
import { config } from '../config/index';

// ─────────────────────────────────────────────────────────────────────────────
// ECDH types (ABDM Curve25519 / X25519)
// ─────────────────────────────────────────────────────────────────────────────
export interface ECDHKeyPair {
  privateKey: string; // base64
  publicKey: string;  // base64
  nonce: string;      // base64 (32 random bytes)
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

  static generateECDHKeyPair(): ECDHKeyPair {
    const keyPair = crypto.generateKeyPairSync('x25519');
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' });
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'der' });
    const nonce = crypto.randomBytes(32);
    return {
      privateKey: privateKey.toString('base64'),
      publicKey: publicKey.toString('base64'),
      nonce: nonce.toString('base64'),
    };
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
   * Build an X25519 public KeyObject from however ABDM/peers encode it.
   * ABDM sends the RAW 32-byte key (base64) per "Curve25519/32byte random key";
   * our own generated keys are SPKI DER (44 bytes). Also tolerate a leading
   * 0x00 byte, PEM, hex, base64url, ASCII-hex-of-bytes, and X448. Parsing
   * mismatched bytes as SPKI DER throws "asn1 ... wrong tag".
   */
  private static toX25519PublicKey(peerPublicKeyB64: string): crypto.KeyObject {
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
   * Derive a 256-bit shared secret using X25519 ECDH + XOR'd nonces as salt for HKDF.
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
    const peerPublicKey = this.toX25519PublicKey(peerPublicKeyB64);

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
   * Generates own keypair, derives shared key with peer's public key + nonce, encrypts with AES-256-GCM.
   * Returns encrypted data (base64) and the HIP's own keyMaterial for the push payload.
   */
  static encryptWithECDH(
    plaintext: string,
    peerPublicKeyB64: string,
    peerNonce: string,
  ): ECDHEncryptResult {
    const ownKeyPair = this.generateECDHKeyPair();
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
