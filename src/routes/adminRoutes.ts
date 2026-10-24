import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import { AdminOrderController } from '../controllers/adminOrderController';
import { AdminManagerController } from '../controllers/adminManagerController';
import { ProductController } from '../controllers/productController';
import { AdminCustomerController } from '../controllers/adminCustomerController';
import { AdminPaymentController } from '../controllers/adminPaymentController';
import { AdminStoreController } from '../controllers/adminStoreController';
import { AdminAuditController } from '../controllers/adminAuditController';
import { AdminBannerController } from '../controllers/adminBannerController';
import { AdminSettingsController } from '../controllers/adminSettingsController';
import { AdminPincodeController } from '../controllers/adminPincodeController';
import { AdminDashboardController } from '../controllers/adminDashboardController';
import { AdminStoreTimingsController } from '../controllers/adminStoreTimingsController';
import { authenticate, requireRole } from '../middlewares/authMiddleware';
import { authRateLimits } from '../middlewares/rateLimit';
import { validateBody } from '../middlewares/validate';
import { adminLoginSchema, createBannerSchema, createManagerSchema, createPincodeSchema, createStoreSchema, togglePincodeStatusSchema, updateBannerSchema, updateCustomerStatusSchema, updateFareCodSettingsSchema, updateManagerSchema, updateOrderStatusSchema, updatePincodeSchema, updateStoreSchema, verifyPickupSchema, updateStoreTimingsSchema, updateStoreCustomTimingsSchema, createStoreHolidaySchema, resolveStoreLocationSchema } from '../validation/schemas';

const router = Router();

// Public Admin Auth
router.post('/login', authRateLimits.adminLoginPerIp, authRateLimits.adminLoginPerEmail, validateBody(adminLoginSchema), AuthController.adminLogin);

// Dashboard summary (P2-07): DB aggregates, store-isolated for managers
router.get(
  '/dashboard/summary',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  AdminDashboardController.getSummary
);

// Protected Admin order routes
router.get(
  '/orders',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  AdminOrderController.getOrders
);

router.get(
  '/orders/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  AdminOrderController.getOrderDetails
);

router.put(
  '/orders/:id/status',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  validateBody(updateOrderStatusSchema),
  AdminOrderController.updateOrderStatus
);

router.post(
  '/orders/pickup-check',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  validateBody(verifyPickupSchema),
  AdminOrderController.checkPickup
);

router.post(
  '/orders/pickup-verify',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  validateBody(verifyPickupSchema),
  AdminOrderController.verifyPickup
);

// Fares and COD settings management (SUPER_ADMIN only)
router.get(
  '/settings/fare-cod',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  AdminSettingsController.getFareCodSettings
);

router.put(
  '/settings/fare-cod',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  validateBody(updateFareCodSettingsSchema),
  AdminSettingsController.updateFareCodSettings
);

// Legacy/general system configuration management
router.get(
  '/settings',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  AdminSettingsController.getFareCodSettings
);

router.put(
  '/settings',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  validateBody(updateFareCodSettingsSchema),
  AdminSettingsController.updateFareCodSettings
);

// Store timings, weekly closed days and holidays (D-015, SUPER_ADMIN only)
router.get('/store-timings', authenticate, requireRole(['SUPER_ADMIN']), AdminStoreTimingsController.getOverview);
router.put('/store-timings', authenticate, requireRole(['SUPER_ADMIN']), validateBody(updateStoreTimingsSchema), AdminStoreTimingsController.updateGlobal);
router.put('/stores/:id/timings', authenticate, requireRole(['SUPER_ADMIN']), validateBody(updateStoreCustomTimingsSchema), AdminStoreTimingsController.updateStore);
router.post('/store-holidays', authenticate, requireRole(['SUPER_ADMIN']), validateBody(createStoreHolidaySchema), AdminStoreTimingsController.addHoliday);
router.delete('/store-holidays/:id', authenticate, requireRole(['SUPER_ADMIN']), AdminStoreTimingsController.removeHoliday);

// Store Manager Management (Super Admin only)
router.get(
  '/managers',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  AdminManagerController.listManagers
);

router.post(
  '/managers',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  validateBody(createManagerSchema),
  AdminManagerController.createManager
);

router.get(
  '/managers/:id',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  AdminManagerController.getManagerById
);

router.put(
  '/managers/:id',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  validateBody(updateManagerSchema),
  AdminManagerController.updateManager
);

// Inventory transactions history log
router.get(
  '/inventory/transactions',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  ProductController.getInventoryHistory
);

// Customer Management Routes (SUPER_ADMIN only)
router.get(
  '/customers',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  AdminCustomerController.getCustomers
);

router.get(
  '/customers/:id',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  AdminCustomerController.getCustomerById
);

router.put(
  '/customers/:id/status',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  validateBody(updateCustomerStatusSchema),
  AdminCustomerController.updateCustomerStatus
);

// Payment Management Routes
router.get(
  '/payments',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  AdminPaymentController.getPayments
);

router.get(
  '/payments/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'STORE_MANAGER']),
  AdminPaymentController.getPaymentDetails
);
router.post('/payments/:id/refund/retry', authenticate, requireRole(['SUPER_ADMIN']), AdminPaymentController.retryRefund);
router.get('/stores', authenticate, requireRole(['SUPER_ADMIN', 'STORE_MANAGER']), AdminStoreController.listStores);
router.get('/stores/:id', authenticate, requireRole(['SUPER_ADMIN', 'STORE_MANAGER']), AdminStoreController.getStoreById);
router.post('/stores', authenticate, requireRole(['SUPER_ADMIN']), validateBody(createStoreSchema), AdminStoreController.createStore);
router.post('/stores/resolve-location', authenticate, requireRole(['SUPER_ADMIN']), validateBody(resolveStoreLocationSchema), AdminStoreController.resolveLocation);
router.put('/stores/:id', authenticate, requireRole(['SUPER_ADMIN']), validateBody(updateStoreSchema), AdminStoreController.updateStore);
router.delete('/stores/:id', authenticate, requireRole(['SUPER_ADMIN']), AdminStoreController.deleteStore);
// System Audit Logs Routes (Super Admin only)
router.get('/audit-logs', authenticate, requireRole(['SUPER_ADMIN']), AdminAuditController.getAuditLogs);
router.get('/audit-logs/actions', authenticate, requireRole(['SUPER_ADMIN']), AdminAuditController.getAuditActions);

// Marketing Banners Routes (Super Admin only)
router.get('/banners', authenticate, requireRole(['SUPER_ADMIN']), AdminBannerController.getBanners);
router.post('/banners', authenticate, requireRole(['SUPER_ADMIN']), validateBody(createBannerSchema), AdminBannerController.createBanner);
router.get('/banners/:id', authenticate, requireRole(['SUPER_ADMIN']), AdminBannerController.getBannerById);
router.put('/banners/:id', authenticate, requireRole(['SUPER_ADMIN']), validateBody(updateBannerSchema), AdminBannerController.updateBanner);
router.delete('/banners/:id', authenticate, requireRole(['SUPER_ADMIN']), AdminBannerController.deleteBanner);

// Supported Pincodes / Delivery Areas (Super Admin only)
router.get('/pincodes', authenticate, requireRole(['SUPER_ADMIN']), AdminPincodeController.listPincodes);
router.post('/pincodes', authenticate, requireRole(['SUPER_ADMIN']), validateBody(createPincodeSchema), AdminPincodeController.createPincode);
router.get('/pincodes/:id', authenticate, requireRole(['SUPER_ADMIN']), AdminPincodeController.getPincodeById);
router.put('/pincodes/:id', authenticate, requireRole(['SUPER_ADMIN']), validateBody(updatePincodeSchema), AdminPincodeController.updatePincode);
router.patch('/pincodes/:id/status', authenticate, requireRole(['SUPER_ADMIN']), validateBody(togglePincodeStatusSchema), AdminPincodeController.togglePincodeStatus);

export default router;
