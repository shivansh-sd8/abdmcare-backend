import { AppError } from '../middleware/errorHandler';

/**
 * Re-throw an error from a service layer without leaking Prisma internals.
 *
 * - If the caught error is already an `AppError` (an intentional, user-facing
 *   error we threw ourselves), rethrow it untouched so the original status code
 *   and friendly message reach the client.
 * - Otherwise it is treated as an unexpected error (Prisma, runtime, network,
 *   etc.) and rethrown as-is. The global error handler then maps it to a safe
 *   message — never echoing the raw Prisma string back to the client.
 *
 * Use this in service `catch` blocks instead of `throw new AppError(error.message, ...)`,
 * which leaks DB column/table names to the frontend.
 */
export function rethrowServiceError(error: unknown, _fallbackMessage = 'Something went wrong'): never {
  if (error instanceof AppError) throw error;
  throw error;
}
