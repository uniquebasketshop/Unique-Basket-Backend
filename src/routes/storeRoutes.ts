import { Router } from 'express';
import { StoreController } from '../controllers/storeController';
import { authenticate, requireRole } from '../middlewares/authMiddleware';
import { validateBody } from '../middlewares/validate';
import { createStoreSchema, updateStoreSchema } from '../validation/schemas';

const router = Router();

// Store routes (accessible to logged-in users)
router.get('/', authenticate, StoreController.listStores);
router.get('/nearby', authenticate, StoreController.listStores); // Alias for coordinates searching
router.get('/:id', authenticate, StoreController.getStoreById);

// Admin-only Store modifications
router.post('/', authenticate, requireRole(['SUPER_ADMIN']), validateBody(createStoreSchema), StoreController.createStore);
router.put('/:id', authenticate, requireRole(['SUPER_ADMIN']), validateBody(updateStoreSchema), StoreController.updateStore);
router.delete('/:id', authenticate, requireRole(['SUPER_ADMIN']), StoreController.deleteStore);

export default router;
