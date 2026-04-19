import { Router } from 'express';
import consentController from './consent.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate } from '../../common/middleware/auth';

const router = Router();

// ABDM Gateway callback (no auth)
router.post('/v0.5/consents/hip/notify', consentController.handleConsentNotification);

// Internal APIs (auth required)
router.use(authenticate);

router.post(
  '/request',
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

router.get('/', consentController.getAllConsents);

router.get('/stats', consentController.getConsentStats);

router.get('/patient/:patientId', consentController.getPatientConsents);

router.get('/:id/artefact', consentController.fetchConsentArtefact);

router.post('/:id/revoke', consentController.revokeConsent);

export default router;
