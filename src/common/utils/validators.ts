export class Validators {
  static isValidAadhaar(aadhaar: string): boolean {
    const aadhaarRegex = /^[2-9]{1}[0-9]{11}$/;
    return aadhaarRegex.test(aadhaar);
  }

  static isValidMobile(mobile: string): boolean {
    const mobileRegex = /^[6-9]\d{9}$/;
    return mobileRegex.test(mobile);
  }

  static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  static isValidAbhaNumber(abhaNumber: string): boolean {
    const abhaRegex = /^\d{14}$/;
    return abhaRegex.test(abhaNumber);
  }

  static isValidAbhaAddress(abhaAddress: string): boolean {
    const abhaAddressRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/;
    return abhaAddressRegex.test(abhaAddress);
  }

  static isValidUHID(uhid: string): boolean {
    return uhid.length >= 6 && uhid.length <= 20;
  }

  static isValidPAN(pan: string): boolean {
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    return panRegex.test(pan);
  }

  static isValidDrivingLicense(dl: string): boolean {
    const dlRegex = /^[A-Z]{2}[0-9]{13}$/;
    return dlRegex.test(dl);
  }

  static sanitizeString(str: string): string {
    return str.trim().replace(/[<>]/g, '');
  }

  static isValidDate(dateString: string): boolean {
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date.getTime());
  }

  static isValidGender(gender: string): boolean {
    return ['MALE', 'FEMALE', 'OTHER'].includes(gender.toUpperCase());
  }
}

export default Validators;
