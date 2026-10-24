import { Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { validatedBody } from '../middlewares/validate';
import { createBannerSchema, updateBannerSchema } from '../validation/schemas';

export class AdminBannerController {
  /**
   * List marketing banners with status filtering, search, and pagination.
   * Access is restricted to SUPER_ADMIN.
   */
  static async getBanners(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        status,
        search,
        page: queryPage,
        limit: queryLimit,
      } = req.query;

      const whereClause: any = {};

      if (status === 'ACTIVE') {
        whereClause.isActive = true;
      } else if (status === 'INACTIVE') {
        whereClause.isActive = false;
      }

      if (search && typeof search === 'string' && search.trim()) {
        whereClause.title = { contains: search.trim(), mode: 'insensitive' };
      }

      const page = queryPage ? parseInt(queryPage as string) : 1;
      const limit = queryLimit ? parseInt(queryLimit as string) : 10;
      const skip = (page - 1) * limit;

      const totalCount = await prisma.banner.count({ where: whereClause });

      const banners = await prisma.banner.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      });

      res.status(200).json({
        success: true,
        data: {
          banners,
          pagination: {
            total: totalCount,
            page,
            limit,
            totalPages: Math.ceil(totalCount / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a new marketing banner.
   * SUPER_ADMIN only.
   */
  static async createBanner(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // validateBody(createBannerSchema)
      const { title, imageUrl, displayOrder, isActive } = validatedBody(res, createBannerSchema);

      const banner = await prisma.banner.create({
        data: {
          title: title ?? null,
          imageUrl,
          displayOrder: displayOrder ?? 0,
          isActive: isActive ?? true,
        },
      });

      // Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'CREATE_BANNER',
          details: `Created marketing banner: "${banner.title || 'Untitled'}" (ID: ${banner.id})`,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Marketing banner created successfully.',
        data: banner,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get single marketing banner by ID.
   * SUPER_ADMIN only.
   */
  static async getBannerById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;

      if (!id) {
        res.status(400).json({
          success: false,
          message: 'Banner ID is required.',
          errorCode: 'INVALID_PARAMETERS',
        });
        return;
      }

      const banner = await prisma.banner.findUnique({
        where: { id },
      });

      if (!banner) {
        res.status(404).json({
          success: false,
          message: 'Marketing banner not found.',
          errorCode: 'BANNER_NOT_FOUND',
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: banner,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update an existing marketing banner.
   * SUPER_ADMIN only.
   */
  static async updateBanner(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;

      if (!id) {
        res.status(400).json({
          success: false,
          message: 'Banner ID is required.',
          errorCode: 'INVALID_PARAMETERS',
        });
        return;
      }

      // validateBody(updateBannerSchema)
      const { title, imageUrl, displayOrder, isActive } = validatedBody(res, updateBannerSchema);

      const existing = await prisma.banner.findUnique({
        where: { id },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          message: 'Marketing banner not found.',
          errorCode: 'BANNER_NOT_FOUND',
        });
        return;
      }

      const updateData: any = {};
      if (title !== undefined) updateData.title = title;
      if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
      if (displayOrder != null) updateData.displayOrder = displayOrder;
      if (isActive !== undefined) updateData.isActive = isActive;

      const updated = await prisma.banner.update({
        where: { id },
        data: updateData,
      });

      // Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'UPDATE_BANNER',
          details: `Updated marketing banner: "${updated.title || 'Untitled'}" (ID: ${updated.id})`,
        },
      });

      res.status(200).json({
        success: true,
        message: 'Marketing banner updated successfully.',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Deactivate or Delete a marketing banner.
   * SUPER_ADMIN only. Soft delete (deactivate) by default.
   */
  static async deleteBanner(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;

      if (!id) {
        res.status(400).json({
          success: false,
          message: 'Banner ID is required.',
          errorCode: 'INVALID_PARAMETERS',
        });
        return;
      }

      const permanent = req.query.permanent === 'true';

      const existing = await prisma.banner.findUnique({
        where: { id },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          message: 'Marketing banner not found.',
          errorCode: 'BANNER_NOT_FOUND',
        });
        return;
      }

      if (permanent) {
        await prisma.banner.delete({
          where: { id },
        });

        await prisma.auditLog.create({
          data: {
            adminUserId: req.user?.id,
            action: 'DELETE_BANNER',
            details: `Permanently deleted marketing banner: "${existing.title || 'Untitled'}" (ID: ${existing.id})`,
          },
        });

        res.status(200).json({
          success: true,
          message: 'Marketing banner permanently deleted.',
        });
      } else {
        const deactivated = await prisma.banner.update({
          where: { id },
          data: { isActive: false },
        });

        await prisma.auditLog.create({
          data: {
            adminUserId: req.user?.id,
            action: 'DEACTIVATE_BANNER',
            details: `Deactivated marketing banner: "${deactivated.title || 'Untitled'}" (ID: ${deactivated.id})`,
          },
        });

        res.status(200).json({
          success: true,
          message: 'Marketing banner deactivated successfully.',
          data: deactivated,
        });
      }
    } catch (error) {
      next(error);
    }
  }
}
