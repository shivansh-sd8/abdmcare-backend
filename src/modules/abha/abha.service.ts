import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import prisma from '../../common/config/database';

interface GenerateOtpRequest {
  aadhaar: string;
}

interface VerifyOtpRequest {
  txnId: string;
  otp: string;
}

interface CreateAbhaRequest {
  txnId: string;
  mobile?: string;
  email?: string;
}

export class AbhaService {
  async generateAadhaarOtp(data: GenerateOtpRequest) {
    try {
      const encryptedAadhaar = abdmClient.encryptSensitiveData(data.aadhaar);

      const response = await abdmClient.post(
        abdmConfig.endpoints.abha.generateAadhaarOtp,
        {
          aadhaar: encryptedAadhaar,
        }
      );

      logger.info('Aadhaar OTP generated successfully', {
        txnId: response.txnId,
      });

      return {
        success: true,
        txnId: response.txnId,
        message: 'OTP sent successfully to registered mobile number',
      };
    } catch (error: any) {
      logger.error('Failed to generate Aadhaar OTP', error);
      throw new AppError(
        error.response?.data?.message || 'Failed to generate OTP',
        error.response?.status || 500
      );
    }
  }

  async verifyAadhaarOtp(data: VerifyOtpRequest) {
    try {
      const encryptedOtp = abdmClient.encryptSensitiveData(data.otp);

      const response = await abdmClient.post(
        abdmConfig.endpoints.abha.verifyAadhaarOtp,
        {
          txnId: data.txnId,
          otp: encryptedOtp,
        }
      );

      logger.info('Aadhaar OTP verified successfully', {
        txnId: data.txnId,
      });

      return {
        success: true,
        txnId: response.txnId,
        message: 'OTP verified successfully',
      };
    } catch (error: any) {
      logger.error('Failed to verify Aadhaar OTP', error);
      throw new AppError(
        error.response?.data?.message || 'Failed to verify OTP',
        error.response?.status || 500
      );
    }
  }

  async createAbha(data: CreateAbhaRequest) {
    try {
      const response = await abdmClient.post(
        abdmConfig.endpoints.abha.createHealthId,
        {
          txnId: data.txnId,
          mobile: data.mobile,
          email: data.email,
        }
      );

      const abhaData = {
        abhaNumber: response.healthIdNumber,
        abhaAddress: response.healthId,
        name: `${response.firstName} ${response.lastName}`,
        firstName: response.firstName,
        middleName: response.middleName,
        lastName: response.lastName,
        gender: response.gender,
        dob: response.dayOfBirth,
        mobile: response.mobile,
        email: response.email,
        profilePhoto: response.profilePhoto,
      };

      await prisma.abhaRecord.create({
        data: {
          abhaNumber: abhaData.abhaNumber,
          abhaAddress: abhaData.abhaAddress,
          aadhaarLinked: true,
          mobileLinked: !!data.mobile,
          kycStatus: 'VERIFIED',
          profileData: abhaData,
        },
      });

      logger.info('ABHA created successfully', {
        abhaNumber: abhaData.abhaNumber,
      });

      return {
        success: true,
        data: abhaData,
        message: 'ABHA created successfully',
      };
    } catch (error: any) {
      logger.error('Failed to create ABHA', error);
      throw new AppError(
        error.response?.data?.message || 'Failed to create ABHA',
        error.response?.status || 500
      );
    }
  }

  async getProfile(abhaId: string) {
    try {
      const response = await abdmClient.post(
        abdmConfig.endpoints.abha.profile,
        {
          healthId: abhaId,
        }
      );

      return {
        success: true,
        data: response,
      };
    } catch (error: any) {
      logger.error('Failed to fetch ABHA profile', error);
      throw new AppError(
        error.response?.data?.message || 'Failed to fetch profile',
        error.response?.status || 500
      );
    }
  }

  async getQrCode(abhaId: string) {
    try {
      const response = await abdmClient.post(
        abdmConfig.endpoints.abha.qrCode,
        {
          healthId: abhaId,
        }
      );

      return {
        success: true,
        data: response.qrCode,
      };
    } catch (error: any) {
      logger.error('Failed to fetch QR code', error);
      throw new AppError(
        error.response?.data?.message || 'Failed to fetch QR code',
        error.response?.status || 500
      );
    }
  }

  async searchAbha(query: { abhaNumber?: string; abhaAddress?: string; mobile?: string }) {
    try {
      const response = await abdmClient.post(
        abdmConfig.endpoints.abha.searchByHealthId,
        query
      );

      return {
        success: true,
        data: response,
      };
    } catch (error: any) {
      logger.error('Failed to search ABHA', error);
      throw new AppError(
        error.response?.data?.message || 'Failed to search ABHA',
        error.response?.status || 500
      );
    }
  }

  async linkToPatient(abhaNumber: string, patientId: string) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      await prisma.patient.update({
        where: { id: patientId },
        data: {
          abhaId: abhaNumber,
        },
      });

      logger.info('ABHA linked to patient successfully', {
        abhaNumber,
        patientId,
      });

      return {
        success: true,
        message: 'ABHA linked to patient successfully',
      };
    } catch (error: any) {
      logger.error('Failed to link ABHA to patient', error);
      throw new AppError(
        error.message || 'Failed to link ABHA',
        error.statusCode || 500
      );
    }
  }
}

export default new AbhaService();
