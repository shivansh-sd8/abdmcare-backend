import prismaClient from '../../common/config/database';
import logger from '../../common/config/logger';

// Cast to any to support newly-generated Prisma models (Medicine, InventoryBatch, StockMovement)
// that may not be recognized by IDE until TS server is restarted
const prisma = prismaClient as any;

export class PharmacyService {
  // ── Medicine Master ─────────────────────────────────────────────────────────

  async listMedicines(hospitalId: string, filters: {
    search?: string;
    category?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  } = {}) {
    const { search, category, isActive = true, page = 1, limit = 50 } = filters;
    const where: any = { hospitalId, isActive };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { genericName: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (category) where.category = category;

    const [medicines, total] = await Promise.all([
      prisma.medicine.findMany({
        where,
        include: {
          batches: {
            where: { quantityAvailable: { gt: 0 } },
            orderBy: { expiryDate: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.medicine.count({ where }),
    ]);

    const data = medicines.map((m: any) => {
      const totalStock = m.batches.reduce((sum: number, b: any) => sum + b.quantityAvailable, 0);
      const nearestExpiry = m.batches.length > 0 ? m.batches[0].expiryDate : null;
      return { ...m, totalStock, nearestExpiry, isLowStock: totalStock <= m.reorderLevel };
    });

    return { medicines: data, total, page, limit };
  }

  async getMedicine(medicineId: string, hospitalId: string) {
    const med = await prisma.medicine.findFirst({
      where: { id: medicineId, hospitalId },
      include: {
        batches: {
          where: { quantityAvailable: { gt: 0 } },
          orderBy: { expiryDate: 'asc' },
        },
        stockMovements: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });
    if (!med) throw new Error('Medicine not found');
    const totalStock = med.batches.reduce((sum: number, b: any) => sum + b.quantityAvailable, 0);
    return { ...med, totalStock, isLowStock: totalStock <= med.reorderLevel };
  }

  async createMedicine(hospitalId: string, data: {
    name: string;
    genericName?: string;
    brand?: string;
    manufacturer?: string;
    category?: string;
    formulation?: string;
    strength?: string;
    unit?: string;
    hsnCode?: string;
    gstPercent?: number;
    mrp?: number;
    sellingPrice?: number;
    reorderLevel?: number;
    schedule?: string;
    storageCondition?: string;
  }) {
    return prisma.medicine.create({
      data: {
        name: data.name,
        genericName: data.genericName,
        brand: data.brand,
        manufacturer: data.manufacturer,
        category: (data.category as any) || 'TABLET',
        formulation: data.formulation,
        strength: data.strength,
        unit: data.unit || 'pcs',
        hsnCode: data.hsnCode,
        gstPercent: data.gstPercent || 0,
        mrp: data.mrp || 0,
        sellingPrice: data.sellingPrice || 0,
        reorderLevel: data.reorderLevel ?? 10,
        schedule: data.schedule,
        storageCondition: data.storageCondition,
        hospitalId,
      },
    });
  }

  async updateMedicine(medicineId: string, hospitalId: string, data: Record<string, any>) {
    const med = await prisma.medicine.findFirst({ where: { id: medicineId, hospitalId } });
    if (!med) throw new Error('Medicine not found');

    const allowed = [
      'name', 'genericName', 'brand', 'manufacturer', 'category', 'formulation',
      'strength', 'unit', 'hsnCode', 'gstPercent', 'mrp', 'sellingPrice',
      'reorderLevel', 'schedule', 'storageCondition', 'isActive',
    ];
    const update: Record<string, any> = {};
    for (const key of allowed) {
      if (data[key] !== undefined) update[key] = data[key];
    }

    return prisma.medicine.update({ where: { id: medicineId }, data: update });
  }

  async deleteMedicine(medicineId: string, hospitalId: string) {
    const med = await prisma.medicine.findFirst({ where: { id: medicineId, hospitalId } });
    if (!med) throw new Error('Medicine not found');
    return prisma.medicine.update({ where: { id: medicineId }, data: { isActive: false } });
  }

  // ── Stock Receive (Batch Entry) ────────────────────────────────────────────

  async receiveStock(hospitalId: string, userId: string, data: {
    medicineId: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
    costPrice: number;
    sellingPrice: number;
    mrp?: number;
  }) {
    const med = await prisma.medicine.findFirst({
      where: { id: data.medicineId, hospitalId, isActive: true },
    });
    if (!med) throw new Error('Medicine not found');
    if (data.quantity <= 0) throw new Error('Quantity must be positive');

    const expiryDate = new Date(data.expiryDate);
    if (expiryDate <= new Date()) throw new Error('Expiry date must be in the future');

    // Upsert batch — if same batch number exists for same medicine+hospital, add to it
    const existingBatch = await prisma.inventoryBatch.findUnique({
      where: {
        medicineId_batchNumber_hospitalId: {
          medicineId: data.medicineId,
          batchNumber: data.batchNumber,
          hospitalId,
        },
      },
    });

    let batch;
    if (existingBatch) {
      batch = await prisma.inventoryBatch.update({
        where: { id: existingBatch.id },
        data: {
          quantityReceived: { increment: data.quantity },
          quantityAvailable: { increment: data.quantity },
          costPrice: data.costPrice,
          sellingPrice: data.sellingPrice,
          mrp: data.mrp,
          receivedBy: userId,
          receivedAt: new Date(),
        },
      });
    } else {
      batch = await prisma.inventoryBatch.create({
        data: {
          medicineId: data.medicineId,
          hospitalId,
          batchNumber: data.batchNumber,
          expiryDate,
          quantityReceived: data.quantity,
          quantityAvailable: data.quantity,
          costPrice: data.costPrice,
          sellingPrice: data.sellingPrice,
          mrp: data.mrp,
          receivedBy: userId,
        },
      });
    }

    // Record stock movement
    const newBalance = batch.quantityAvailable;
    await prisma.stockMovement.create({
      data: {
        medicineId: data.medicineId,
        batchId: batch.id,
        hospitalId,
        type: 'IN',
        quantity: data.quantity,
        referenceType: 'STOCK_RECEIVE',
        reason: `Batch ${data.batchNumber} received`,
        performedBy: userId,
        balanceAfter: newBalance,
      },
    });

    logger.info(`Stock received: ${data.quantity} of ${med.name} (batch ${data.batchNumber}) at hospital ${hospitalId}`);
    return batch;
  }

  // ── Stock Overview ─────────────────────────────────────────────────────────

  async getStockOverview(hospitalId: string) {
    const medicines = await prisma.medicine.findMany({
      where: { hospitalId, isActive: true },
      include: {
        batches: {
          where: { quantityAvailable: { gt: 0 } },
          orderBy: { expiryDate: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    let totalMedicines = 0;
    let totalStock = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    let totalStockValue = 0;

    const items = medicines.map((m: any) => {
      const stock = m.batches.reduce((sum: number, b: any) => sum + b.quantityAvailable, 0);
      const value = m.batches.reduce((sum: number, b: any) => sum + b.quantityAvailable * Number(b.sellingPrice), 0);
      totalMedicines++;
      totalStock += stock;
      totalStockValue += value;
      if (stock === 0) outOfStockCount++;
      else if (stock <= m.reorderLevel) lowStockCount++;

      return {
        id: m.id,
        name: m.name,
        genericName: m.genericName,
        category: m.category,
        unit: m.unit,
        sellingPrice: m.sellingPrice,
        reorderLevel: m.reorderLevel,
        totalStock: stock,
        stockValue: value,
        isLowStock: stock > 0 && stock <= m.reorderLevel,
        isOutOfStock: stock === 0,
        nearestExpiry: m.batches.length > 0 ? m.batches[0].expiryDate : null,
        batchCount: m.batches.length,
      };
    });

    return {
      summary: { totalMedicines, totalStock, lowStockCount, outOfStockCount, totalStockValue },
      items,
    };
  }

  async getLowStockMedicines(hospitalId: string) {
    const medicines = await prisma.medicine.findMany({
      where: { hospitalId, isActive: true },
      include: {
        batches: { where: { quantityAvailable: { gt: 0 } } },
      },
    });

    return medicines
      .map((m: any) => {
        const stock = m.batches.reduce((sum: number, b: any) => sum + b.quantityAvailable, 0);
        return { ...m, totalStock: stock };
      })
      .filter((m: any) => m.totalStock <= m.reorderLevel)
      .sort((a: any, b: any) => a.totalStock - b.totalStock);
  }

  async getExpiringBatches(hospitalId: string, daysAhead: number = 90) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + daysAhead);

    return prisma.inventoryBatch.findMany({
      where: {
        hospitalId,
        quantityAvailable: { gt: 0 },
        expiryDate: { lte: cutoff },
      },
      include: { medicine: { select: { name: true, genericName: true, category: true, unit: true } } },
      orderBy: { expiryDate: 'asc' },
    });
  }

  // ── Stock Adjustment ───────────────────────────────────────────────────────

  async adjustStock(hospitalId: string, userId: string, data: {
    medicineId: string;
    batchId: string;
    adjustment: number; // positive = add, negative = deduct
    reason: string;
  }) {
    const batch = await prisma.inventoryBatch.findFirst({
      where: { id: data.batchId, medicineId: data.medicineId, hospitalId },
    });
    if (!batch) throw new Error('Batch not found');
    if (batch.quantityAvailable + data.adjustment < 0) {
      throw new Error('Adjustment would result in negative stock');
    }

    const updated = await prisma.inventoryBatch.update({
      where: { id: data.batchId },
      data: { quantityAvailable: { increment: data.adjustment } },
    });

    await prisma.stockMovement.create({
      data: {
        medicineId: data.medicineId,
        batchId: data.batchId,
        hospitalId,
        type: 'ADJUSTMENT',
        quantity: data.adjustment,
        reason: data.reason,
        performedBy: userId,
        balanceAfter: updated.quantityAvailable,
      },
    });

    return updated;
  }

  // ── Stock Movements (Audit Log) ────────────────────────────────────────────

  async getStockMovements(hospitalId: string, filters: {
    medicineId?: string;
    type?: string;
    page?: number;
    limit?: number;
  } = {}) {
    const { medicineId, type, page = 1, limit = 50 } = filters;
    const where: any = { hospitalId };
    if (medicineId) where.medicineId = medicineId;
    if (type) where.type = type;

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: {
          medicine: { select: { name: true, genericName: true, unit: true } },
          batch: { select: { batchNumber: true, expiryDate: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.stockMovement.count({ where }),
    ]);

    return { movements, total, page, limit };
  }

  // ── Dispense Stock (called during prescription dispensing) ──────────────────

  async deductStockForDispense(
    hospitalId: string,
    userId: string,
    medicineId: string,
    quantity: number,
    prescriptionId: string,
  ) {
    // FEFO: First Expiry, First Out
    const batches = await prisma.inventoryBatch.findMany({
      where: { medicineId, hospitalId, quantityAvailable: { gt: 0 } },
      orderBy: { expiryDate: 'asc' },
    });

    let remaining = quantity;
    const deductions: { batchId: string; qty: number }[] = [];

    for (const batch of batches) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, batch.quantityAvailable);
      deductions.push({ batchId: batch.id, qty: deduct });
      remaining -= deduct;
    }

    if (remaining > 0) {
      logger.warn(`Insufficient stock for medicine ${medicineId}: needed ${quantity}, available ${quantity - remaining}`);
    }

    // Apply deductions
    for (const d of deductions) {
      const updated = await prisma.inventoryBatch.update({
        where: { id: d.batchId },
        data: { quantityAvailable: { decrement: d.qty } },
      });

      await prisma.stockMovement.create({
        data: {
          medicineId,
          batchId: d.batchId,
          hospitalId,
          type: 'OUT',
          quantity: -d.qty,
          referenceType: 'PRESCRIPTION',
          referenceId: prescriptionId,
          performedBy: userId,
          balanceAfter: updated.quantityAvailable,
        },
      });
    }

    return { deducted: quantity - remaining, shortfall: remaining };
  }

  // ── Dashboard Stats ────────────────────────────────────────────────────────

  async getDashboardStats(hospitalId: string) {
    const [totalMedicines, lowStockMeds, expiringBatches] = await Promise.all([
      prisma.medicine.count({ where: { hospitalId, isActive: true } }),
      this.getLowStockMedicines(hospitalId),
      this.getExpiringBatches(hospitalId, 90),
    ]);

    const overview = await this.getStockOverview(hospitalId);

    return {
      totalMedicines,
      totalStock: overview.summary.totalStock,
      lowStockCount: lowStockMeds.length,
      expiringCount: expiringBatches.length,
      outOfStockCount: overview.summary.outOfStockCount,
      totalStockValue: overview.summary.totalStockValue,
    };
  }
}

export default new PharmacyService();
