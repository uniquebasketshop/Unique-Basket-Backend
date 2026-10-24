import { Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { loadFareSettings } from '../services/pricingService';
import { validatedBody } from '../middlewares/validate';
import { updateFareCodSettingsSchema } from '../validation/schemas';

export class AdminSettingsController {
  /**
   * Fetch current Fare and COD configurations.
   * Access: SUPER_ADMIN only.
   */
  static async getFareCodSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const settings = await prisma.deliverySettings.findFirst();
      const fares = await loadFareSettings(prisma);

      const data = settings
        ? { id: settings.id, ...fares, updatedAt: settings.updatedAt }
        : fares;

      res.status(200).json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update Fare and COD configurations with strict validation.
   * Access: SUPER_ADMIN only.
   */
  static async updateFareCodSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // validateBody(updateFareCodSettingsSchema): numbers are finite, flags are booleans
      const {
        deliveryEnabled,
        deliveryFee,
        freeDeliveryThreshold,
        minimumOrderAmount,
        codEnabled,
        codCharge,
        minimumCodOrderAmount,
        maximumCodOrderAmount,
        pickupCodEnabled,
      } = validatedBody(res, updateFareCodSettingsSchema);

      const current = await prisma.deliverySettings.findFirst();
      // Unspecified fields keep their current value (or the shared defaults when no row exists)
      const base = await loadFareSettings(prisma);

      const parsedDeliveryFee = deliveryFee ?? base.deliveryFee;
      const parsedFreeDeliveryThreshold = freeDeliveryThreshold ?? base.freeDeliveryThreshold;
      const parsedMinimumOrderAmount = minimumOrderAmount ?? base.minimumOrderAmount;
      const parsedCodCharge = codCharge ?? base.codCharge;
      const parsedMinCod = minimumCodOrderAmount ?? base.minimumCodOrderAmount;
      const parsedMaxCod = maximumCodOrderAmount ?? base.maximumCodOrderAmount;

      const resolvedDeliveryEnabled = deliveryEnabled ?? base.deliveryEnabled;
      const resolvedCodEnabled = codEnabled ?? base.codEnabled;
      const resolvedPickupCodEnabled = pickupCodEnabled ?? base.pickupCodEnabled;

      // Validation 2: Monetary values cannot be negative
      if (
        parsedDeliveryFee < 0 ||
        parsedFreeDeliveryThreshold < 0 ||
        parsedMinimumOrderAmount < 0 ||
        parsedCodCharge < 0 ||
        parsedMinCod < 0 ||
        parsedMaxCod < 0
      ) {
        res.status(400).json({
          success: false,
          message: 'Monetary settings values cannot be negative.',
          errorCode: 'NEGATIVE_VALUES_NOT_ALLOWED',
        });
        return;
      }

      // Validation 3: minimumCodOrderAmount must not exceed maximumCodOrderAmount
      if (parsedMinCod > parsedMaxCod) {
        res.status(400).json({
          success: false,
          message: 'Minimum COD amount cannot be greater than maximum COD amount.',
          errorCode: 'INVALID_COD_RANGE',
        });
        return;
      }

      const updated = await prisma.deliverySettings.upsert({
        where: {
          id: current?.id || '00000000-0000-0000-0000-000000000000',
        },
        update: {
          deliveryEnabled: resolvedDeliveryEnabled,
          deliveryFee: parsedDeliveryFee,
          freeDeliveryThreshold: parsedFreeDeliveryThreshold,
          minimumOrderAmount: parsedMinimumOrderAmount,
          codEnabled: resolvedCodEnabled,
          codCharge: parsedCodCharge,
          minimumCodOrderAmount: parsedMinCod,
          maximumCodOrderAmount: parsedMaxCod,
          pickupCodEnabled: resolvedPickupCodEnabled,
        },
        create: {
          deliveryEnabled: resolvedDeliveryEnabled,
          deliveryFee: parsedDeliveryFee,
          freeDeliveryThreshold: parsedFreeDeliveryThreshold,
          minimumOrderAmount: parsedMinimumOrderAmount,
          codEnabled: resolvedCodEnabled,
          codCharge: parsedCodCharge,
          minimumCodOrderAmount: parsedMinCod,
          maximumCodOrderAmount: parsedMaxCod,
          pickupCodEnabled: resolvedPickupCodEnabled,
        },
      });

      // Write Audit Log
      await prisma.auditLog.create({
        data: {
          adminUserId: req.user?.id,
          action: 'FARE_COD_SETTINGS_UPDATED',
          details: JSON.stringify({
            previous: current
              ? {
                  deliveryEnabled: current.deliveryEnabled,
                  deliveryFee: Number(current.deliveryFee),
                  freeDeliveryThreshold: Number(current.freeDeliveryThreshold),
                  minimumOrderAmount: Number(current.minimumOrderAmount),
                  codEnabled: current.codEnabled,
                  codCharge: Number(current.codCharge),
                  minimumCodOrderAmount: Number(current.minimumCodOrderAmount),
                  maximumCodOrderAmount: Number(current.maximumCodOrderAmount),
                  pickupCodEnabled: current.pickupCodEnabled,
                }
              : null,
            new: {
              deliveryEnabled: updated.deliveryEnabled,
              deliveryFee: Number(updated.deliveryFee),
              freeDeliveryThreshold: Number(updated.freeDeliveryThreshold),
              minimumOrderAmount: Number(updated.minimumOrderAmount),
              codEnabled: updated.codEnabled,
              codCharge: Number(updated.codCharge),
              minimumCodOrderAmount: Number(updated.minimumCodOrderAmount),
              maximumCodOrderAmount: Number(updated.maximumCodOrderAmount),
              pickupCodEnabled: updated.pickupCodEnabled,
            },
          }),
        },
      });

      res.status(200).json({
        success: true,
        message: 'Fares and COD settings updated successfully.',
        data: {
          id: updated.id,
          deliveryEnabled: updated.deliveryEnabled,
          deliveryFee: Number(updated.deliveryFee),
          freeDeliveryThreshold: Number(updated.freeDeliveryThreshold),
          minimumOrderAmount: Number(updated.minimumOrderAmount),
          codEnabled: updated.codEnabled,
          codCharge: Number(updated.codCharge),
          minimumCodOrderAmount: Number(updated.minimumCodOrderAmount),
          maximumCodOrderAmount: Number(updated.maximumCodOrderAmount),
          pickupCodEnabled: updated.pickupCodEnabled,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
