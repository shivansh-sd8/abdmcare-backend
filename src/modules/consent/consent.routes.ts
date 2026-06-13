import { Router } from 'express';
import consentController from './consent.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

// Internal APIs (auth required)
router.use(authenticate);
router.use(auditLog('CONSENT'));

router.post(
  '/request',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  [
    body('patientAbhaId').notEmpty().withMessage('Patient ABHA ID is required'),
    body('purpose').notEmpty().withMessage('Purpose is required'),
    body('hiTypes').isArray().withMessage('HI types must be an array'),
    body('dateRangeFrom').isISO8601().withMessage('Valid from date is required'),
    body('dateRangeTo').isISO8601().withMessage('Valid to date is required'),
    body('requesterName').notEmpty().withMessage('Requester name is required'),
    body('requesterId').notEmpty().withMessage('Requester ID is required'),
  ],
  validate,
  consentController.createConsentRequest
);

// Reads are open to clinical and front-desk staff so the nurse can
// confirm consent before a procedure and the receptionist can answer
// "is consent in place?" at check-in. Writes (request/revoke) stay
// restricted to clinicians and admins.
const READ_ROLES = ['SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'] as const;

router.get('/', authorize(...READ_ROLES), consentController.getAllConsents);

router.get('/stats', authorize(...READ_ROLES), consentController.getConsentStats);

router.get('/patient/:patientId', authorize(...READ_ROLES), consentController.getPatientConsents);

router.get('/:id/status', authorize(...READ_ROLES), consentController.getConsentStatus);

router.get('/:id/artefact', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), consentController.fetchConsentArtefact);

router.post('/:id/revoke', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), consentController.revokeConsent);

export default router;
