import { Router } from 'express';
import { BannerController } from '../controllers/bannerController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();

// Customer-facing active banners endpoint
router.get('/', authenticate, BannerController.getBanners);

export default router;
