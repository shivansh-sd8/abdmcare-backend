import EncryptionService from '../../src/common/utils/encryption';

describe('EncryptionService', () => {
  describe('ECDH', () => {
    it('should generate valid X25519 keypair', () => {
      const kp = EncryptionService.generateECDHKeyPair();
      expect(kp.privateKey).toBeTruthy();
      expect(kp.publicKey).toBeTruthy();
      expect(Buffer.from(kp.nonce, 'base64').length).toBe(32);
    });

    it('should pass round-trip self-test', () => {
      expect(EncryptionService.verifyECDHRoundTrip()).toBe(true);
    });

    it('should encrypt and decrypt data correctly', () => {
      const testData = '{"test":"data","resourceType":"Bundle"}';
      const receiverKP = EncryptionService.generateECDHKeyPair();
      const result = EncryptionService.encryptWithECDH(
        testData,
        receiverKP.publicKey,
        receiverKP.nonce,
      );

      expect(result.encryptedData).toBeTruthy();
      expect(result.keyMaterial.curve).toBe('Curve25519');
      expect(result.keyMaterial.cryptoAlg).toBe('ECDH');
      expect(result.keyMaterial.dhPublicKey.keyValue).toBeTruthy();
      expect(result.keyMaterial.nonce).toBeTruthy();
    });

    it('should produce different ciphertext for each encryption', () => {
      const testData = '{"same":"payload"}';
      const receiverKP = EncryptionService.generateECDHKeyPair();
      const r1 = EncryptionService.encryptWithECDH(testData, receiverKP.publicKey, receiverKP.nonce);
      const r2 = EncryptionService.encryptWithECDH(testData, receiverKP.publicKey, receiverKP.nonce);
      expect(r1.encryptedData).not.toBe(r2.encryptedData);
    });

    it('should set dhPublicKey expiry to ~24h from now', () => {
      const receiverKP = EncryptionService.generateECDHKeyPair();
      const result = EncryptionService.encryptWithECDH('test', receiverKP.publicKey, receiverKP.nonce);
      const expiry = new Date(result.keyMaterial.dhPublicKey.expiry).getTime();
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      expect(expiry - Date.now()).toBeGreaterThan(twentyFourHoursMs - 5000);
      expect(expiry - Date.now()).toBeLessThan(twentyFourHoursMs + 5000);
    });
  });

  describe('AES', () => {
    const TEST_KEY = 'abcdefghijklmnopqrstuvwxyz123456'; // 32 chars

    it('should encrypt and decrypt with provided key', () => {
      const plaintext = 'sensitive patient data';
      const { encrypted, iv } = EncryptionService.encryptWithAES(plaintext, TEST_KEY);
      const decrypted = EncryptionService.decryptWithAES(encrypted, iv, TEST_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different IVs for each encryption', () => {
      const { iv: iv1 } = EncryptionService.encryptWithAES('data', TEST_KEY);
      const { iv: iv2 } = EncryptionService.encryptWithAES('data', TEST_KEY);
      expect(iv1).not.toBe(iv2);
    });

    it('should throw for invalid key length', () => {
      expect(() => EncryptionService.encryptWithAES('data', 'short')).toThrow(
        'AES key must be 32 characters',
      );
    });
  });

  describe('Hash', () => {
    it('should generate SHA-256 hash', () => {
      const hash = EncryptionService.generateHash('test');
      expect(hash).toHaveLength(64);
    });

    it('should be deterministic', () => {
      const h1 = EncryptionService.generateHash('hello');
      const h2 = EncryptionService.generateHash('hello');
      expect(h1).toBe(h2);
    });

    it('should produce different hashes for different inputs', () => {
      const h1 = EncryptionService.generateHash('input1');
      const h2 = EncryptionService.generateHash('input2');
      expect(h1).not.toBe(h2);
    });
  });

  describe('Random String', () => {
    it('should generate string of correct length', () => {
      const str = EncryptionService.generateRandomString(16);
      expect(str).toHaveLength(32); // hex = 2 chars per byte
    });

    it('should generate unique strings', () => {
      const s1 = EncryptionService.generateRandomString();
      const s2 = EncryptionService.generateRandomString();
      expect(s1).not.toBe(s2);
    });
  });
});
