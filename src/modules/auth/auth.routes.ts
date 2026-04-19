import { Router } from 'express';
import { AuthController } from './auth.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { loginLimiter } from '../../common/middleware/rateLimiter';

const router = Router();
const authController = new AuthController();

router.post(
  '/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  authController.login
);

router.post(
  '/register',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('name').notEmpty().withMessage('Name is required'),
  ],
  validate,
  authController.register
);

router.post(
  '/refresh',
  [body('refreshToken').notEmpty().withMessage('Refresh token is required')],
  validate,
  authController.refreshToken
);

router.post('/logout', authController.logout);

export default router;
