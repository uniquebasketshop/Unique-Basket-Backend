import { Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { validatedBody } from '../middlewares/validate';
import { updateCustomerStatusSchema } from '../validation/schemas';
import { isDeletedAccount } from '../utils/deletedAccount';

export class AdminCustomerController {
  /**
   * Get paginated customer list with search, status filter, and server-side sorting.
   * Access is limited to SUPER_ADMIN.
   */
  static async getCustomers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const search = (req.query.search as string) || '';
      const status = (req.query.status as string) || 'ALL';
      const sortBy = (req.query.sortBy as string) || 'newest';
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;

      const whereClause: any = {};

      if (status === 'ACTIVE') {
        whereClause.isActive = true;
      } else if (status === 'INACTIVE') {
        whereClause.isActive = false;
      }

      if (search.trim()) {
        const searchStr = search.trim();
        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(searchStr);

        const searchConditions: any[] = [
          { name: { contains: searchStr, mode: 'insensitive' } },
          { phone: { contains: searchStr, mode: 'insensitive' } },
        ];

        if (isUuid) {
          searchConditions.push({ id: searchStr });
        }

        whereClause.OR = searchConditions;
      }

      const totalCount = await prisma.user.count({ where: whereClause });

      let customers: any[] = [];

      if (sortBy === 'spend_desc' || sortBy === 'spend_asc') {
        // Query matching users with orders, calculate spend, sort globally, then paginate
        const allMatchingUsers = await prisma.user.findMany({
          where: whereClause,
          include: {
            orders: {
              select: {
                total: true,
                orderStatus: true,
              },
            },
          },
        });

        const formatted = allMatchingUsers.map((u) => {
          const orderCount = u.orders.length;
          const totalSpent = u.orders
            .filter((o) => o.orderStatus !== 'CANCELLED')
            .reduce((sum, o) => sum + Number(o.total), 0);

          return {
            id: u.id,
            phone: u.phone,
            name: u.name || (isDeletedAccount(u) ? 'Deleted customer' : 'Unnamed Customer'),
            email: u.email || null,
            dob: u.dob ? u.dob.toISOString() : null,
            gender: u.gender || null,
            avatarId: u.avatarId ?? null,
            isActive: u.isActive,
            isDeleted: isDeletedAccount(u),
            createdAt: u.createdAt,
            updatedAt: u.updatedAt,
            orderCount,
            totalSpent: parseFloat(totalSpent.toFixed(2)),
          };
        });

        if (sortBy === 'spend_desc') {
          formatted.sort(
            (a, b) => b.totalSpent - a.totalSpent || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        } else {
          formatted.sort(
            (a, b) => a.totalSpent - b.totalSpent || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        }

        customers = formatted.slice(skip, skip + limit);
      } else {
        let orderBy: any = [{ createdAt: 'desc' }];

        if (sortBy === 'orders_desc') {
          orderBy = [{ orders: { _count: 'desc' } }, { createdAt: 'desc' }];
        } else if (sortBy === 'orders_asc') {
          orderBy = [{ orders: { _count: 'asc' } }, { createdAt: 'desc' }];
        }

        const users = await prisma.user.findMany({
          where: whereClause,
          skip,
          take: limit,
          orderBy,
          include: {
            orders: {
              select: {
                total: true,
                orderStatus: true,
              },
            },
          },
        });

        customers = users.map((u) => {
          const orderCount = u.orders.length;
          const totalSpent = u.orders
            .filter((o) => o.orderStatus !== 'CANCELLED')
            .reduce((sum, o) => sum + Number(o.total), 0);

          return {
            id: u.id,
            phone: u.phone,
            name: u.name || (isDeletedAccount(u) ? 'Deleted customer' : 'Unnamed Customer'),
            email: u.email || null,
            dob: u.dob ? u.dob.toISOString() : null,
            gender: u.gender || null,
            avatarId: u.avatarId ?? null,
            isActive: u.isActive,
            isDeleted: isDeletedAccount(u),
            createdAt: u.createdAt,
            updatedAt: u.updatedAt,
            orderCount,
            totalSpent: parseFloat(totalSpent.toFixed(2)),
          };
        });
      }

      res.status(200).json({
        success: true,
        data: {
          customers,
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
   * Get detailed profile for a single customer including addresses, order history, and statistics.
   * Access is limited to SUPER_ADMIN.
   */
  static async getCustomerById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;

      if (!id) {
        res.status(400).json({
          success: false,
          message: 'Customer ID is required.',
          errorCode: 'INVALID_PARAMETERS',
        });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id },
        include: {
          addresses: {
            orderBy: { createdAt: 'desc' },
          },
          orders: {
            include: {
              store: {
                select: {
                  name: true,
                  storeId: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!user) {
        res.status(404).json({
          success: false,
          message: 'Customer profile not found.',
          errorCode: 'CUSTOMER_NOT_FOUND',
        });
        return;
      }

      const totalOrders = user.orders.length;
      const completedOrders = user.orders.filter(
        (o) => o.orderStatus === 'DELIVERED' || o.orderStatus === 'PICKED_UP'
      ).length;
      const cancelledOrders = user.orders.filter((o) => o.orderStatus === 'CANCELLED').length;
      const totalSpent = user.orders
        .filter((o) => o.orderStatus !== 'CANCELLED')
        .reduce((sum, o) => sum + Number(o.total), 0);

      const formattedOrders = user.orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        storeName: o.store.name,
        storeId: o.store.storeId,
        fulfillmentType: o.fulfillmentType,
        orderStatus: o.orderStatus,
        paymentStatus: o.paymentStatus,
        total: Number(o.total),
      }));

      res.status(200).json({
        success: true,
        data: {
          customer: {
            id: user.id,
            phone: user.phone,
            name: user.name || (isDeletedAccount(user) ? 'Deleted customer' : 'Unnamed Customer'),
            avatarId: user.avatarId ?? null,
            email: user.email || null,
            dob: user.dob ? user.dob.toISOString() : null,
            gender: user.gender || null,
            isActive: user.isActive,
            isDeleted: isDeletedAccount(user),
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
          stats: {
            totalOrders,
            completedOrders,
            cancelledOrders,
            totalSpent: parseFloat(totalSpent.toFixed(2)),
          },
          addresses: user.addresses.map((a) => ({
            id: a.id,
            title: a.title,
            addressLine: a.addressLine,
            city: a.city,
            state: a.state,
            pincode: a.pincode,
            latitude: Number(a.latitude),
            longitude: Number(a.longitude),
            isDefault: a.isDefault,
          })),
          orders: formattedOrders,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Activate or Deactivate a customer account.
   * Access is limited to SUPER_ADMIN.
   */
  static async updateCustomerStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;

      if (!id) {
        res.status(400).json({
          success: false,
          message: 'Customer ID is required.',
          errorCode: 'INVALID_PARAMETERS',
        });
        return;
      }

      // validateBody(updateCustomerStatusSchema): isActive is a boolean
      const { isActive } = validatedBody(res, updateCustomerStatusSchema);

      const user = await prisma.user.findUnique({ where: { id } });

      if (!user) {
        res.status(404).json({
          success: false,
          message: 'Customer not found.',
          errorCode: 'CUSTOMER_NOT_FOUND',
        });
        return;
      }

      // The customer deleted this account: it holds no personal data and cannot be switched back on.
      if (isDeletedAccount(user)) {
        res.status(409).json({
          success: false,
          message: 'This customer deleted their account. It cannot be reactivated; they can sign up again with their phone number.',
          errorCode: 'ACCOUNT_DELETED',
        });
        return;
      }

      const updatedUser = await prisma.user.update({
        where: { id },
        data: { isActive },
      });

      const action = isActive ? 'CUSTOMER_ACTIVATED' : 'CUSTOMER_DEACTIVATED';

      // Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action,
          details: `${action}: Customer ${user.name || user.phone} (ID: ${user.id}) status set to ${isActive ? 'ACTIVE' : 'INACTIVE'}.`,
        },
      });

      res.status(200).json({
        success: true,
        message: `Customer account successfully ${isActive ? 'activated' : 'deactivated'}.`,
        data: {
          id: updatedUser.id,
          phone: updatedUser.phone,
          name: updatedUser.name,
          isActive: updatedUser.isActive,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
