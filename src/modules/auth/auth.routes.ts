import { Router } from 'express';
import { AuthController } from './auth.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';

const router = Router();
const authController = new AuthController();

router.use(auditLog('AUTH'));

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  authController.login
);

const registerValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('role')
    .notEmpty().withMessage('Role is required')
    .custom((value) => {
      // Only allow specific roles - SUPER_ADMIN validation will be done in controller
      const allowedRoles = ['SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST'];
      if (!allowedRoles.includes(value)) {
        throw new Error(`Invalid role. Allowed roles: ${allowedRoles.join(', ')}`);
      }
      return true;
    }),
];

// Super Admin Signup - Public route with secret key
router.post(
  '/super-admin-signup',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters'),
    body('firstName').notEmpty().withMessage('First name is required'),
    body('lastName').notEmpty().withMessage('Last name is required'),
    body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
    body('secretKey').notEmpty().withMessage('Secret key is required'),
  ],
  validate,
  authController.superAdminSignup
);

// Regular user registration - requires authentication + SUPER_ADMIN or ADMIN role
router.post('/register', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), registerValidation, validate, authController.register);
router.post('/signup', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), registerValidation, validate, authController.register);

router.post(
  '/refresh',
  [body('refreshToken').notEmpty().withMessage('Refresh token is required')],
  validate,
  authController.refreshToken
);

router.post('/logout', authController.logout);

// User Management - SUPER_ADMIN and ADMIN
router.get('/users', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), authController.getAllUsers);
router.get('/users/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), authController.getUserById);
router.put('/users/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), authController.updateUser);
router.delete('/users/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), authController.deleteUser);

export default router;
