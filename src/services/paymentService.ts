import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';

interface CreatePaymentDTO {
  patientId: string;
  hospitalId: string;
  appointmentId?: string;
  amount: number;
  paymentMethod: string;
  description?: string;
  items?: any;
  createdBy?: string;
}

interface UpdatePaymentDTO {
  status?: string;
  transactionId?: string;
  paidAt?: Date;
}

class PaymentService {
  async createPayment(data: CreatePaymentDTO) {
    // Generate receipt number
    const receiptNumber = `RCP-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    const payment = await prisma.payment.create({
      data: {
        patientId: data.patientId,
        hospitalId: data.hospitalId,
        appointmentId: data.appointmentId,
        amount: data.amount,
        paymentMethod: data.paymentMethod as any,
        description: data.description,
        items: data.items,
        receiptNumber,
        createdBy: data.createdBy,
        status: 'PENDING',
      },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
            uhid: true,
            mobile: true,
          },
        },
        hospital: {
          select: {
            name: true,
            code: true,
          },
        },
        appointment: {
          select: {
            appointmentId: true,
            scheduledAt: true,
          },
        },
      },
    });

    return payment;
  }

  async getAllPayments(filters: {
    hospitalId?: string;
    patientId?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const { hospitalId, patientId, status, startDate, endDate, page = 1, limit = 50 } = filters;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (hospitalId) where.hospitalId = hospitalId;
    if (patientId) where.patientId = patientId;
    if (status) where.status = status;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          patient: {
            select: {
              firstName: true,
              lastName: true,
              uhid: true,
              mobile: true,
            },
          },
          hospital: {
            select: {
              name: true,
              code: true,
            },
          },
          appointment: {
            select: {
              appointmentId: true,
              scheduledAt: true,
            },
          },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    return {
      payments,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getPaymentById(id: string) {
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
            uhid: true,
            mobile: true,
            email: true,
          },
        },
        hospital: {
          select: {
            name: true,
            code: true,
            address: true,
            phone: true,
            email: true,
          },
        },
        appointment: {
          select: {
            appointmentId: true,
            scheduledAt: true,
            doctor: {
              select: {
                firstName: true,
                lastName: true,
                specialization: true,
              },
            },
          },
        },
      },
    });

    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    return payment;
  }

  async updatePayment(id: string, data: UpdatePaymentDTO) {
    const payment = await prisma.payment.findUnique({
      where: { id },
    });

    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    const updated = await prisma.payment.update({
      where: { id },
      data: {
        status: data.status as any,
        transactionId: data.transactionId,
        paidAt: data.paidAt,
      },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
            uhid: true,
          },
        },
      },
    });

    return updated;
  }

  async markAsPaid(id: string, transactionId?: string) {
    return this.updatePayment(id, {
      status: 'PAID',
      transactionId,
      paidAt: new Date(),
    });
  }

  async getPaymentStats(hospitalId?: string) {
    const where: any = {};
    if (hospitalId) where.hospitalId = hospitalId;

    const [totalRevenue, todayRevenue, pendingPayments, paidPayments] = await Promise.all([
      prisma.payment.aggregate({
        where: { ...where, status: 'PAID' },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: {
          ...where,
          status: 'PAID',
          paidAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
        _sum: { amount: true },
      }),
      prisma.payment.count({
        where: { ...where, status: 'PENDING' },
      }),
      prisma.payment.count({
        where: { ...where, status: 'PAID' },
      }),
    ]);

    return {
      totalRevenue: totalRevenue._sum.amount || 0,
      todayRevenue: todayRevenue._sum.amount || 0,
      pendingPayments,
      paidPayments,
    };
  }
}

export default new PaymentService();
