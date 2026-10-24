import { Router } from 'express';
import { publicReadPerIp } from '../middlewares/rateLimit';
import { CustomerController } from '../controllers/customerController';
import { authenticate, requireRole } from '../middlewares/authMiddleware';
import { validateBody } from '../middlewares/validate';
import { addAddressSchema, updateAddressSchema, updateProfileSchema } from '../validation/schemas';

const router = Router();

// Profile endpoints
router.get('/profile', authenticate, requireRole(['customer']), CustomerController.getProfile);
router.put('/profile', authenticate, requireRole(['customer']), validateBody(updateProfileSchema), CustomerController.updateProfile);
router.delete('/account', authenticate, requireRole(['customer']), CustomerController.deleteAccount);

// Address endpoints
router.get('/addresses', authenticate, requireRole(['customer']), CustomerController.getAddresses);
router.post('/addresses', authenticate, requireRole(['customer']), validateBody(addAddressSchema), CustomerController.addAddress);
router.put('/addresses/:id', authenticate, requireRole(['customer']), validateBody(updateAddressSchema), CustomerController.updateAddress);
router.patch('/addresses/:id/default', authenticate, requireRole(['customer']), CustomerController.setDefaultAddress);
router.delete('/addresses/:id', authenticate, requireRole(['customer']), CustomerController.deleteAddress);

// Favorites endpoints
router.get('/favorites', authenticate, requireRole(['customer']), CustomerController.getFavorites);
router.post('/favorites', authenticate, requireRole(['customer']), CustomerController.addFavorite);
router.post('/favorites/:productId', authenticate, requireRole(['customer']), CustomerController.addFavorite);
router.delete('/favorites/:productId', authenticate, requireRole(['customer']), CustomerController.removeFavorite);

// Delivery Settings & Serviceability Pincodes endpoints
router.get('/delivery-settings', publicReadPerIp, CustomerController.getDeliverySettings);
router.get('/store-timings', authenticate, requireRole(['customer']), CustomerController.getStoreTimings);
router.get('/pincodes', publicReadPerIp, CustomerController.getSupportedPincodes);
router.get('/serviceability/check', publicReadPerIp, CustomerController.checkPincodeServiceability);

export default router;

