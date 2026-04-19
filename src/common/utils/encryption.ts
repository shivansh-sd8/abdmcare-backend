import crypto from 'crypto';
import fs from 'fs';
import { config } from '../config/index';

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
}

export default EncryptionService;
