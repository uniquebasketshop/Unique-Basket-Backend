import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import { authRateLimits } from '../middlewares/rateLimit';
import { validateBody } from '../middlewares/validate';
import { sendOtpSchema, verifyOtpSchema } from '../validation/schemas';

const router = Router();

router.post('/send-otp', authRateLimits.sendOtpPerIp, validateBody(sendOtpSchema), AuthController.sendOtp);
router.post('/verify-otp', authRateLimits.verifyOtpPerIp, validateBody(verifyOtpSchema), AuthController.verifyOtp);
router.post('/refresh', authRateLimits.refreshPerIp, AuthController.refresh);
router.post('/logout', AuthController.logout);

export default router;
