import { Router } from 'express';
import { validateBody } from '../middlewares/validate';
import { registerDeviceTokenSchema } from '../validation/schemas';
import { NotificationController } from '../controllers/notificationController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();

// Customer in-app notification inbox
router.get('/', authenticate, NotificationController.getNotifications);
router.get('/unread-count', authenticate, NotificationController.getUnreadCount);
router.patch('/read-all', authenticate, NotificationController.markAllAsRead);
router.patch('/:id/read', authenticate, NotificationController.markAsRead);

// Device token registration
router.post('/tokens', authenticate, validateBody(registerDeviceTokenSchema), NotificationController.registerToken);

export default router;
