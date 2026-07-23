import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { createLimiter } from '../../common/middleware/rateLimiter';
import enquiryController from './enquiry.controller';

const router = Router();

// Tight per-IP limit — this endpoint is unauthenticated and faces the public
// internet. 5 submissions per hour per IP is more than enough for legitimate
// users and blunts spam bots even before our honeypot kicks in.
const enquiryLimiter = createLimiter(60 * 60 * 1000, 5);

const validation = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('Please share your full name.'),
  body('email')
    .isEmail()
    .withMessage('Please enter a valid email address.')
    .isLength({ max: 200 })
    .withMessage('Email is too long.'),
  body('phone')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 6, max: 20 })
    .withMessage('Phone looks too short / too long.'),
  body('hospitalName')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('Hospital name is too long.'),
  body('role')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 80 })
    .withMessage('Role label is too long.'),
  body('message')
    .trim()
    .isLength({ min: 10, max: 2000 })
    .withMessage('Tell us a bit more about what you need (10–2000 characters).'),
  body('source')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 80 }),
  // Honeypot: must be empty. We don't tell bots — the controller silently 200s.
  body('website').optional().isLength({ max: 200 }),
];

/**
 * @openapi
 * /enquiry:
 *   post:
 *     tags: [Enquiry]
 *     summary: Submit a public "request access" enquiry
 *     description: |
 *       Accepts a contact-us submission from the marketing site and forwards it
 *       to the configured internal mailbox via SMTP. Rate-limited to 5/hour per
 *       IP. Includes a honeypot field (`website`) that should be left empty.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, message]
 *             properties:
 *               name:         { type: string, minLength: 2, maxLength: 120 }
 *               email:        { type: string, format: email }
 *               phone:        { type: string }
 *               hospitalName: { type: string }
 *               role:         { type: string, description: 'e.g. Owner, Admin, IT lead' }
 *               message:      { type: string, minLength: 10, maxLength: 2000 }
 *               source:       { type: string, description: 'Where on the site the form was opened from' }
 *               website:      { type: string, description: 'Honeypot — leave empty' }
 *     responses:
 *       200:
 *         description: Enquiry accepted (delivery is best-effort).
 *       422:
 *         description: Validation failed.
 *       429:
 *         description: Too many submissions from this IP.
 */
router.post('/', enquiryLimiter, validation, validate, enquiryController.submit);

export default router;
