-- AlterTable
ALTER TABLE "encounters" ADD COLUMN     "paymentCollected" DECIMAL(10,2),
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "transactionRef" TEXT;
