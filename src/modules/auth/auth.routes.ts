import { Router } from 'express';
import { AuthController } from './auth.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';
import { loginLimiter } from '../../common/middleware/rateLimiter';

const router = Router();
const authController = new AuthController();

router.use(auditLog('AUTH'));

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login with email and password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful — returns JWT token and user info
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Too many login attempts
 */
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

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new staff user
 *     description: Requires SUPER_ADMIN or ADMIN role. Creates a user with the specified role and hospital assignment.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, firstName, lastName, username, phone, role]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 6 }
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               username: { type: string, minLength: 3 }
 *               phone: { type: string }
 *               role:
 *                 type: string
 *                 enum: [ADMIN, DOCTOR, NURSE, RECEPTIONIST, LAB_TECHNICIAN, PHARMACIST]
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Insufficient permissions
 */
router.post('/register', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), registerValidation, validate, authController.register);
router.post('/signup', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), registerValidation, validate, authController.register);

router.post(
  '/refresh',
  authController.refreshToken
);

router.post('/logout', authController.logout);

// Password management
router.post(
  '/forgot-password',
  [body('email').isEmail().withMessage('Valid email is required')],
  validate,
  authController.forgotPassword
);

router.post(
  '/reset-password',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').notEmpty().withMessage('Reset code is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate,
  authController.resetPassword
);

router.post(
  '/update-password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  validate,
  authController.updatePassword
);

// Profile and Settings - Authenticated users (any role)
router.get('/users/profile', authenticate, authController.getProfile);
router.put('/users/profile', authenticate, authController.updateProfile);
router.put('/users/settings', authenticate, authController.updateSettings);

// User Management - SUPER_ADMIN and ADMIN
router.get('/users', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), authController.getAllUsers);
router.get('/users/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), authController.getUserById);
router.put('/users/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), authController.updateUser);
router.delete('/users/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), authController.deleteUser);

export default router;
