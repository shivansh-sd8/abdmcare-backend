import { Router } from 'express';
import hipController from './hip.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';

const router = Router();

// ABDM Gateway callbacks (no auth required - verified by ABDM signature)
router.post('/v0.5/care-contexts/discover', hipController.discoverCareContexts);
router.post('/v0.5/links/link/init', hipController.linkCareContexts);
router.post('/v0.5/health-information/hip/request', hipController.handleHealthInformationRequest);

// Internal APIs (auth required)
router.post(
  '/patients/:patientId/care-contexts',
  [
    body('careContexts').isArray().withMessage('Care contexts must be an array'),
    body('careContexts.*.encounterId').notEmpty().withMessage('Encounter ID is required'),
    body('careContexts.*.display').notEmpty().withMessage('Display name is required'),
  ],
  validate,
  hipController.addCareContexts
);

export default router;
