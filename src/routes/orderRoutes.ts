import { Router } from 'express';
import { OrderController } from '../controllers/orderController';
import { authenticate, requireRole } from '../middlewares/authMiddleware';
import { validateBody } from '../middlewares/validate';
import { createOrderSchema } from '../validation/schemas';

const router = Router();

router.post('/', authenticate, requireRole(['customer']), validateBody(createOrderSchema), OrderController.createOrder);
router.get('/', authenticate, requireRole(['customer']), OrderController.getOrders);
router.get('/:id', authenticate, requireRole(['customer']), OrderController.getOrderById);
// Customer cancellation endpoint removed per business policy

export default router;
