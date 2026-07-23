import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    hospitalId?: string;
    doctorId?: string;
    /**
     * SUPER_ADMIN-only — set by `authenticate` middleware when the global
     * "viewing as" hospital scope (?hospitalId=<id>) is supplied. Services
     * read this through the `hospitalScope()` / `getEffectiveHospitalId()`
     * helpers so SUPER_ADMINs see only the selected hospital's data while
     * still retaining cross-hospital access controls.
     */
    scopedHospitalId?: string;
  };
}

export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
