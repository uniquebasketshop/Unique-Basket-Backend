import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';

export class BannerController {
  /**
   * List marketing banners for customer home carousel.
   * Returns active banners sorted by displayOrder ascending, then createdAt descending.
   */
  static async getBanners(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const banners = await prisma.banner.findMany({
        where: { isActive: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      });

      res.status(200).json({
        success: true,
        data: banners,
      });
    } catch (error) {
      next(error);
    }
  }
}
