import { Router } from 'express';
import { CategoryController } from '../controllers/categoryController';
import { authenticate, requireRole } from '../middlewares/authMiddleware';
import { validateBody } from '../middlewares/validate';
import { createCategorySchema, updateCategorySchema } from '../validation/schemas';

const router = Router();

// Public / Authenticated Customer endpoints
router.get('/', authenticate, CategoryController.getCategories);

// Super Admin modifications
router.post('/', authenticate, requireRole(['SUPER_ADMIN']), validateBody(createCategorySchema), CategoryController.createCategory);
router.put('/:id', authenticate, requireRole(['SUPER_ADMIN']), validateBody(updateCategorySchema), CategoryController.updateCategory);
router.delete('/:id', authenticate, requireRole(['SUPER_ADMIN']), CategoryController.deleteCategory);

export default router;
