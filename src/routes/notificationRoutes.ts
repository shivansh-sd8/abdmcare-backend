import { Router } from 'express';
import { authenticate } from '../common/middleware/auth';
import * as notificationController from '../controllers/notificationController';

const router = Router();

router.use(authenticate);

router.get('/', notificationController.getNotifications);
router.put('/mark-all-read', notificationController.markAllAsRead);
router.put('/:id/read', notificationController.markAsRead);
router.delete('/:id', notificationController.deleteNotification);

export default router;
