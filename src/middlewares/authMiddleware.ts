import { Response, NextFunction } from 'express';
import { Request } from 'express';
import { verifyAccessToken, TokenPayload } from '../utils/jwt';
import { prisma } from '../config/db';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

/**
 * Authenticates requests checking the JWT authorization header.
 */
export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        message: 'Access denied. No authorization token provided.',
        errorCode: 'UNAUTHORIZED_ACCESS',
      });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    
    // Validate active status for administrative roles
    if (decoded.role === 'SUPER_ADMIN' || decoded.role === 'STORE_MANAGER') {
      const dbUser = await prisma.adminUser.findUnique({
        where: { id: decoded.id },
        select: {
          isActive: true,
          role: true,
          managers: { select: { storeId: true }, orderBy: { assignedAt: 'asc' }, take: 1 },
        },
      });

      if (!dbUser || !dbUser.isActive) {
        res.status(401).json({
          success: false,
          message: 'Account is deactivated or does not exist.',
          errorCode: 'ACCOUNT_DEACTIVATED',
        });
        return;
      }

      // P1-10: role and store assignment come from the database, not the (possibly stale) token claim
      decoded.role = dbUser.role;
      decoded.storeId = dbUser.role === 'STORE_MANAGER' ? dbUser.managers[0]?.storeId : undefined;

      // A store manager without a store assignment must not fall through to unfiltered (all-store) queries
      if (dbUser.role === 'STORE_MANAGER' && !decoded.storeId) {
        res.status(403).json({
          success: false,
          message: 'No store is assigned to this manager account.',
          errorCode: 'NO_STORE_ASSIGNMENT',
        });
        return;
      }
    } else if (decoded.role === 'customer') {
      const customer = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { isActive: true },
      });

      if (!customer || !customer.isActive) {
        res.status(401).json({
          success: false,
          message: 'Customer account is deactivated.',
          errorCode: 'ACCOUNT_DEACTIVATED',
        });
        return;
      }
    }

    req.user = decoded;
    next();
  } catch (error: any) {
    res.status(401).json({
      success: false,
      message: 'Authentication failed. Invalid or expired token.',
      errorCode: 'INVALID_TOKEN',
    });
  }
}

/**
 * Enforces role-based checks on routes.
 */
export function requireRole(roles: Array<'customer' | 'SUPER_ADMIN' | 'STORE_MANAGER'>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required.',
        errorCode: 'UNAUTHORIZED',
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: 'Forbidden. You do not have permissions to access this resource.',
        errorCode: 'FORBIDDEN_ACCESS',
      });
      return;
    }

    next();
  };
}

/**
 * Enforces store-level isolation checks.
 * Super Admin gets complete access.
 * Store Managers are restricted to their assigned store ID.
 */
export function requireStoreAccess(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: 'Authentication required.',
      errorCode: 'UNAUTHORIZED',
    });
    return;
  }

  // Super Admin can access all stores
  if (req.user.role === 'SUPER_ADMIN') {
    next();
    return;
  }

  if (req.user.role === 'STORE_MANAGER') {
    // Extract target storeId from params, query, or body
    const targetStoreId = req.params.storeId || req.query.storeId || req.body.storeId;

    if (!targetStoreId) {
      res.status(400).json({
        success: false,
        message: 'Missing Store ID in request parameters.',
        errorCode: 'MISSING_STORE_ID',
      });
      return;
    }

    // Verify manager is assigned to this store ID
    if (req.user.storeId !== targetStoreId) {
      res.status(403).json({
        success: false,
        message: 'Access Denied. You are not authorized to access or modify data for this store.',
        errorCode: 'STORE_ACCESS_FORBIDDEN',
      });
      return;
    }

    next();
    return;
  }

  // Customers do not have administrative store dashboard access
  res.status(403).json({
    success: false,
    message: 'Access Denied. Administrative role required.',
    errorCode: 'FORBIDDEN',
  });
}

/**
 * Enforces store-level read access isolation for managers on catalog/store routes.
 * Customers and Super Admins can access, but Store Managers are restricted to their assigned store ID.
 */
export function restrictManagerAccess(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role === 'STORE_MANAGER') {
    const targetStoreId = req.params.storeId || req.query.storeId || req.body.storeId;

    if (targetStoreId && req.user.storeId !== targetStoreId) {
      res.status(403).json({
        success: false,
        message: 'Access Denied. You are not authorized to view or edit data for this store.',
        errorCode: 'STORE_ACCESS_FORBIDDEN',
      });
      return;
    }
  }
  next();
}

