import { Router } from 'express';
import hiuController from './hiu.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate } from '../../common/middleware/auth';

const router = Router();

// ABDM Gateway callback (no auth)
router.post('/v0.5/health-information/transfer', hiuController.receiveHealthInformation);

// Internal APIs (auth required)
router.use(authenticate);

router.post(
  '/request',
  [
    body('consentId').notEmpty().withMessage('Consent ID is required'),
    body('dateRangeFrom').isISO8601().withMessage('Valid from date is required'),
    body('dateRangeTo').isISO8601().withMessage('Valid to date is required'),
    body('dataPushUrl').isURL().withMessage('Valid data push URL is required'),
  ],
  validate,
  hiuController.requestHealthInformation
);

router.get('/patient/:patientId/records', hiuController.getPatientHealthRecords);

export default router;
