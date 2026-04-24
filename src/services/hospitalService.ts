import prisma from '../common/config/database';

interface CreateHospitalDTO {
  name: string;
  code: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
  email?: string;
  plan?: string;
  hipId?: string;
  hiuId?: string;
  abdmEnabled?: boolean;
}

interface UpdateHospitalDTO {
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
  email?: string;
  isActive?: boolean;
  plan?: string;
  hipId?: string;
  hiuId?: string;
  abdmEnabled?: boolean;
}

class HospitalService {
  async createHospital(data: CreateHospitalDTO) {
    const existingHospital = await prisma.hospital.findUnique({
      where: { code: data.code },
    });

    if (existingHospital) {
      throw new Error('Hospital with this code already exists');
    }

    // Convert empty strings to null for unique fields
    const hospitalData: any = {
      ...data,
      hipId: data.hipId && data.hipId.trim() !== '' ? data.hipId : null,
      hiuId: data.hiuId && data.hiuId.trim() !== '' ? data.hiuId : null,
    };

    return prisma.hospital.create({
      data: hospitalData,
    });
  }

  async getAllHospitals(filters: {
    isActive?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const { isActive, search, page = 1, limit = 50 } = filters;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [hospitals, total] = await Promise.all([
      prisma.hospital.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              users: true,
              doctors: true,
              appointments: true,
            },
          },
        },
      }),
      prisma.hospital.count({ where }),
    ]);

    return {
      hospitals,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getHospitalById(id: string) {
    const hospital = await prisma.hospital.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            doctors: true,
            appointments: true,
          },
        },
      },
    });

    if (!hospital) {
      throw new Error('Hospital not found');
    }

    return hospital;
  }

  async updateHospital(id: string, data: UpdateHospitalDTO) {
    const hospital = await prisma.hospital.findUnique({
      where: { id },
    });

    if (!hospital) {
      throw new Error('Hospital not found');
    }

    return prisma.hospital.update({
      where: { id },
      data: data as any,
    });
  }

  async deleteHospital(id: string) {
    const hospital = await prisma.hospital.findUnique({
      where: { id },
    });

    if (!hospital) {
      throw new Error('Hospital not found');
    }

    // Soft delete - just mark as inactive
    return prisma.hospital.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async getHospitalStats(hospitalId: string) {
    const [users, doctors, appointments, activeAppointments] = await Promise.all([
      prisma.user.count({ where: { hospitalId } }),
      prisma.doctor.count({ where: { hospitalId } }),
      prisma.appointment.count({ where: { hospitalId } }),
      prisma.appointment.count({
        where: {
          hospitalId,
          status: 'SCHEDULED',
        },
      }),
    ]);

    // Note: Patients are cross-hospital in ABDM architecture
    // Patient count is not hospital-specific
    return {
      users,
      doctors,
      appointments,
      activeAppointments,
    };
  }
}

export default new HospitalService();
