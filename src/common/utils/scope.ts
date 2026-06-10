import { AppError } from '../middleware/errorHandler';

/**
 * Hospital scope helpers — single source of truth for "which hospital should
 * this query be filtered to?".
 *
 *   - non-SUPER_ADMIN  → always their JWT hospitalId (multi-tenant isolation)
 *   - SUPER_ADMIN with the global "viewing as" hospital scope (?hospitalId=)
 *                      → that hospital
 *   - SUPER_ADMIN with no scope → undefined (cross-hospital / platform view)
 *
 * Use these helpers to drive `where` clauses on listing endpoints. Don't use
 * them for access-control checks (e.g. "can this user read patient X?") —
 * those should keep the existing `role !== 'SUPER_ADMIN'` guards because a
 * SUPER_ADMIN must always retain cross-hospital read access regardless of
 * which hospital they've currently scoped to.
 *
 * Failure mode: a non-SUPER_ADMIN whose JWT has no `hospitalId` is a
 * misconfiguration, not a "view all hospitals" pass. We fail closed by
 * throwing an AppError; the caller should handle that as a 403, not silently
 * widen the query to cross-hospital scope.
 */

/**
 * The hospital ID that should appear in `where: { hospitalId: ... }` for the
 * given currentUser, or `undefined` to mean "no filter" (SUPER_ADMIN
 * platform view only). Throws for a non-SUPER_ADMIN with no `hospitalId`
 * on their JWT — that user must never see cross-hospital data.
 */
export function getEffectiveHospitalId(currentUser?: any): string | undefined {
  if (!currentUser) return undefined; // unauthenticated reads (rare) — caller decides
  if (currentUser.role === 'SUPER_ADMIN') {
    return currentUser.scopedHospitalId || undefined;
  }
  if (!currentUser.hospitalId) {
    throw new AppError('Your account is not linked to a hospital', 403);
  }
  return currentUser.hospitalId;
}

/**
 * Returns `{ hospitalId }` or `{}` so it can be spread directly into a Prisma
 * `where` clause:
 *
 *     const where = { ...filters, ...hospitalScope(currentUser) };
 *
 * Same failure semantics as getEffectiveHospitalId.
 */
export function hospitalScope(currentUser?: any): { hospitalId?: string } {
  const id = getEffectiveHospitalId(currentUser);
  return id ? { hospitalId: id } : {};
}
