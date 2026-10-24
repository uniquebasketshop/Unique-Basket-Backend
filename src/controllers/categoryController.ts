import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { getParam } from '../utils/request';
import { paginationMeta, parsePagination } from '../utils/pagination';
import { validatedBody } from '../middlewares/validate';
import { createCategorySchema, updateCategorySchema } from '../validation/schemas';

export class CategoryController {
  /**
   * List Categories.
   * If customer, only return active categories.
   * If Super Admin, support search and status filters.
   */
  static async getCategories(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { search, isActive } = req.query;
      const role = (req as AuthenticatedRequest).user?.role;

      const whereClause: any = {};

      if (role !== 'SUPER_ADMIN') {
        // Customers only see active categories
        whereClause.isActive = true;
      } else {
        // Super Admin filters
        if (isActive !== undefined) {
          whereClause.isActive = isActive === 'true';
        }
        if (search) {
          whereClause.OR = [
            { name: { contains: search as string, mode: 'insensitive' } },
            { description: { contains: search as string, mode: 'insensitive' } },
          ];
        }
      }

      const paging = parsePagination(req.query);
      const [categories, total] = await Promise.all([
        prisma.category.findMany({
          where: whereClause,
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          ...(paging ? { skip: paging.skip, take: paging.limit } : {}),
        }),
        paging ? prisma.category.count({ where: whereClause }) : Promise.resolve(0),
      ]);

      res.status(200).json({
        success: true,
        data: paging ? { categories, pagination: paginationMeta(total, paging) } : categories,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Super Admin Create Category.
   */
  static async createCategory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // validateBody(createCategorySchema)
      const { name, description, imageUrl, displayOrder } = validatedBody(res, createCategorySchema);

      const existing = await prisma.category.findUnique({
        where: { name },
      });

      if (existing) {
        res.status(400).json({
          success: false,
          message: 'Category with this name already exists.',
          errorCode: 'DUPLICATE_CATEGORY_NAME',
        });
        return;
      }

      const category = await prisma.category.create({
        data: {
          name,
          description: description ?? null,
          imageUrl: imageUrl ?? null,
          displayOrder: displayOrder ?? 0,
        },
      });

      // Write Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'CATEGORY_CREATED',
          details: `Created category: ${name}`,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Category created successfully.',
        data: category,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Super Admin Update Category.
   */
  static async updateCategory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = getParam(req, 'id');
      // validateBody(updateCategorySchema)
      const { name, description, imageUrl, displayOrder, isActive } = validatedBody(res, updateCategorySchema);

      const category = await prisma.category.findUnique({
        where: { id },
      });

      if (!category) {
        res.status(404).json({
          success: false,
          message: 'Category not found.',
          errorCode: 'CATEGORY_NOT_FOUND',
        });
        return;
      }

      // Check unique name if changed
      if (name && name !== category.name) {
        const existingName = await prisma.category.findUnique({
          where: { name },
        });
        if (existingName) {
          res.status(400).json({
            success: false,
            message: 'Category with this name already exists.',
            errorCode: 'DUPLICATE_CATEGORY_NAME',
          });
          return;
        }
      }

      const updated = await prisma.category.update({
        where: { id },
        data: {
          name,
          description,
          imageUrl,
          displayOrder: displayOrder ?? undefined,
          isActive,
        },
      });

      // Handle activation / deactivation logs
      if (isActive !== undefined && isActive !== category.isActive) {
        await prisma.auditLog.create({
          data: {
            adminUserId: req.user?.id,
            action: isActive ? 'CATEGORY_ACTIVATED' : 'CATEGORY_DEACTIVATED',
            details: `${isActive ? 'Activated' : 'Deactivated'} category: ${updated.name}`,
          },
        });
      }

      // Write Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'CATEGORY_UPDATED',
          details: `Updated category: ${updated.name}`,
        },
      });

      res.status(200).json({
        success: true,
        message: 'Category updated successfully.',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Super Admin Deactivate Category (Soft delete).
   */
  static async deleteCategory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = getParam(req, 'id');

      const category = await prisma.category.findUnique({
        where: { id },
      });

      if (!category) {
        res.status(404).json({
          success: false,
          message: 'Category not found.',
          errorCode: 'CATEGORY_NOT_FOUND',
        });
        return;
      }

      // Soft delete: deactivate category
      const deactivated = await prisma.category.update({
        where: { id },
        data: { isActive: false },
      });

      // Write Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'CATEGORY_DEACTIVATED',
          details: `Deactivated category: ${category.name}`,
        },
      });

      res.status(200).json({
        success: true,
        message: 'Category deactivated successfully.',
        data: deactivated,
      });
    } catch (error) {
      next(error);
    }
  }
}
