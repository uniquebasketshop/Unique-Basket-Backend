import { Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { calculateHaversineDistance } from '../utils/distance';
import { getParam } from '../utils/request';
import { validatedBody } from '../middlewares/validate';
import { createStoreSchema, updateStoreSchema } from '../validation/schemas';


/** Pickup stores within this distance are shown as "Nearby" in the app (D-016). */
export const PICKUP_NEARBY_RADIUS_KM = 10;

export class StoreController {
  /**
   * Super Admin Create Store endpoint.
   */
  static async createStore(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // validateBody(createStoreSchema): required fields, pincode, coordinates, radius, phone/email formats
      const {
        storeId,
        name,
        address,
        city,
        state,
        pincode,
        latitude,
        longitude,
        deliveryRadiusKm,
        phone,
        email,
        openingTime,
        closingTime,
      } = validatedBody(res, createStoreSchema);

      // Check if storeId is unique
      const existing = await prisma.store.findUnique({
        where: { storeId },
      });

      if (existing) {
        res.status(400).json({
          success: false,
          message: `Store with ID ${storeId} already exists.`,
          errorCode: 'DUPLICATE_STORE_ID',
        });
        return;
      }

      const store = await prisma.store.create({
        data: {
          storeId,
          name,
          address,
          city,
          state,
          pincode,
          latitude,
          longitude,
          deliveryRadiusKm,
          phone,
          email: email ?? null,
          openingTime,
          closingTime,
        },
      });

      // Write Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'CREATE_STORE',
          details: `Created new store: ${name} (${storeId})`,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Store created successfully.',
        data: store,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Super Admin Update Store endpoint.
   */
  static async updateStore(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = getParam(req, 'id');
      // validateBody(updateStoreSchema)
      const updateData = validatedBody(res, updateStoreSchema);

      const store = await prisma.store.findUnique({
        where: { id },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          message: 'Store not found.',
          errorCode: 'STORE_NOT_FOUND',
        });
        return;
      }

      const updatedStore = await prisma.store.update({
        where: { id },
        data: {
          name: updateData.name,
          address: updateData.address,
          city: updateData.city,
          state: updateData.state,
          pincode: updateData.pincode,
          latitude: updateData.latitude ?? undefined,
          longitude: updateData.longitude ?? undefined,
          deliveryRadiusKm: updateData.deliveryRadiusKm ?? undefined,
          phone: updateData.phone,
          email: updateData.email,
          openingTime: updateData.openingTime,
          closingTime: updateData.closingTime,
          isActive: updateData.isActive,
        },
      });

      // Write Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'UPDATE_STORE',
          details: `Updated store details for: ${updatedStore.name} (${updatedStore.storeId})`,
        },
      });

      res.status(200).json({
        success: true,
        message: 'Store updated successfully.',
        data: updatedStore,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Super Admin Deactivate/Delete Store endpoint.
   */
  static async deleteStore(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = getParam(req, 'id');

      const store = await prisma.store.findUnique({
        where: { id },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          message: 'Store not found.',
          errorCode: 'STORE_NOT_FOUND',
        });
        return;
      }

      // Soft delete: deactivate store
      const deactivatedStore = await prisma.store.update({
        where: { id },
        data: { isActive: false },
      });

      // Write Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'DEACTIVATE_STORE',
          details: `Deactivated store: ${store.name} (${store.storeId})`,
        },
      });

      res.status(200).json({
        success: true,
        message: 'Store deactivated successfully.',
        data: deactivatedStore,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List Stores (Includes Distance/Eligibility checking if coordinates provided).
   */
  static async listStores(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { lat, lng, fulfillment } = req.query;

      // Fetch active stores for clients, or all stores for admins
      const isAdmin = req.user && req.user.role !== 'customer';
      const stores = await prisma.store.findMany({
        where: isAdmin ? undefined : { isActive: true },
      });

      if (lat && lng) {
        const clientLat = parseFloat(lat as string);
        const clientLng = parseFloat(lng as string);

        if (isNaN(clientLat) || isNaN(clientLng)) {
          res.status(400).json({
            success: false,
            message: 'Invalid coordinate parameters.',
            errorCode: 'INVALID_COORDINATES',
          });
          return;
        }

        const mappedStores = stores.map((store) => {
          const distanceKm = calculateHaversineDistance(
            clientLat,
            clientLng,
            Number(store.latitude),
            Number(store.longitude)
          );

          const isEligible = distanceKm <= Number(store.deliveryRadiusKm);

          return {
            ...store,
            distanceKm,
            isEligible,
          };
        });

        // Filter and sort
        let result = mappedStores;
        
        if (fulfillment === 'DELIVERY') {
          // Keep all, but sort closest eligible first
          result = mappedStores.sort((a, b) => {
            if (a.isEligible && !b.isEligible) return -1;
            if (!a.isEligible && b.isEligible) return 1;
            return a.distanceKm - b.distanceKm;
          });
        } else if (fulfillment === 'PICKUP') {
          // D-016: stores within PICKUP_NEARBY_RADIUS_KM are suggested first; every active store stays selectable.
          result = mappedStores
            .map((store) => ({ ...store, isNearby: store.distanceKm <= PICKUP_NEARBY_RADIUS_KM }))
            .sort((a, b) => a.distanceKm - b.distanceKm);
        } else {
          // Standard sort by distance
          result = mappedStores.sort((a, b) => a.distanceKm - b.distanceKm);
        }

        res.status(200).json({
          success: true,
          data: result,
        });
        return;
      }

      // No coordinates provided, return raw list sorted by storeId
      const sortedStores = stores.sort((a, b) => a.storeId.localeCompare(b.storeId));
      res.status(200).json({
        success: true,
        data: sortedStores,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * View Store Details endpoint.
   */
  static async getStoreById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = getParam(req, 'id');

      const store = await prisma.store.findUnique({
        where: { id },
        include: {
          managers: {
            include: {
              adminUser: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
      });

      const role = req.user?.role;
      const isStaff = role === 'SUPER_ADMIN' || role === 'STORE_MANAGER';

      if (!store || (!isStaff && !store.isActive)) {
        res.status(404).json({
          success: false,
          message: 'Store not found or currently inactive.',
          errorCode: 'STORE_NOT_FOUND',
        });
        return;
      }

      // Manager names/emails are staff data: Super Admin, or that store's own manager, only.
      const canSeeManagers = role === 'SUPER_ADMIN' || (role === 'STORE_MANAGER' && req.user?.storeId === store.id);
      const { managers, ...storeFields } = store;

      res.status(200).json({
        success: true,
        data: canSeeManagers ? store : storeFields,
      });
    } catch (error) {
      next(error);
    }
  }
}
