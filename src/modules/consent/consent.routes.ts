import { Router } from 'express';
import consentController from './consent.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

// ABDM Gateway callback (no auth)
router.post('/v0.5/consents/hip/notify', consentController.handleConsentNotification);

// Internal APIs (auth required)
router.use(authenticate);

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

router.get('/', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), consentController.getAllConsents);

router.get('/stats', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), consentController.getConsentStats);

router.get('/patient/:patientId', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), consentController.getPatientConsents);

router.get('/:id/artefact', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), consentController.fetchConsentArtefact);

router.post('/:id/revoke', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), consentController.revokeConsent);

export default router;
