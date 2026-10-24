import { Router } from 'express';
import { PaymentController } from '../controllers/paymentController';
import { authenticate, requireRole } from '../middlewares/authMiddleware';
import { rateLimit } from '../middlewares/rateLimit';

const router = Router();
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const paymentPerIp = rateLimit({ name: 'payment-ip', windowMs: FIFTEEN_MINUTES, max: 120 });

// Customer payment flow (own orders only)
router.post('/orders/:orderId/session', paymentPerIp, authenticate, requireRole(['customer']), PaymentController.createSession);
router.get('/orders/:orderId/status', paymentPerIp, authenticate, requireRole(['customer']), PaymentController.getStatus);
router.post('/orders/:orderId/switch-to-cash', paymentPerIp, authenticate, requireRole(['customer']), PaymentController.switchToCash);

// Cashfree server-to-server notifications (signature-verified, no login)
router.post('/webhook/cashfree', PaymentController.cashfreeWebhook);

export default router;
