import { Router } from 'express';
import { CartController } from '../controllers/cartController';
import { authenticate, requireRole } from '../middlewares/authMiddleware';
import { validateBody } from '../middlewares/validate';
import { addCartItemSchema, updateCartItemSchema } from '../validation/schemas';

const router = Router();

// All cart operations require customer authentication
router.get('/', authenticate, requireRole(['customer']), CartController.getCart);
router.post('/items', authenticate, requireRole(['customer']), validateBody(addCartItemSchema), CartController.addItem);
router.put('/items/:id', authenticate, requireRole(['customer']), validateBody(updateCartItemSchema), CartController.updateItem);
router.delete('/items/:id', authenticate, requireRole(['customer']), CartController.removeItem);

export default router;
