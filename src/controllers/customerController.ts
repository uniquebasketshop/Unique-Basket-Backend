import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { getParam, requireUserId } from '../utils/request';
import { validatedBody } from '../middlewares/validate';
import { addAddressSchema, updateAddressSchema, updateProfileSchema } from '../validation/schemas';
import { loadFareSettings } from '../services/pricingService';
import { isOnlinePaymentConfigured } from '../services/payments/paymentService';
import { getCustomerProfile, updateCustomerProfile } from '../services/customerService';
import { deleteCustomerAccount } from '../services/accountDeletionService';
import { createAddress, deleteAddress, listAddresses, setDefaultAddress, updateAddress } from '../services/addressService';
import { addFavorite, listFavorites, removeFavorite } from '../services/favoriteService';
import { checkPincode, listActivePincodes } from '../services/serviceabilityService';
import { getCustomerAvailability } from '../services/storeScheduleService';

const queryString = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * Customer-facing profile, address book, favourites and serviceability endpoints.
 * Thin HTTP layer (P2-01): request parsing → service → response. Business rules live in
 * services/customerService, addressService, favoriteService and serviceabilityService;
 * errors are AppErrors rendered by the global handler with their stable errorCodes.
 */
export class CustomerController {
  /** GET /customer/profile */
  static async getProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await getCustomerProfile(requireUserId(req));
      res.status(200).json({ success: true, data: { user } });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /customer/profile — body validated by updateProfileSchema */
  static async updateProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await updateCustomerProfile(requireUserId(req), validatedBody(res, updateProfileSchema));
      res.status(200).json({ success: true, message: 'Profile updated successfully.', data: { user } });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /customer/account — customer deletes their own account (orders kept, personal data removed) */
  static async deleteAccount(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await deleteCustomerAccount(requireUserId(req));
      res.status(200).json({ success: true, message: 'Your account has been deleted.' });
    } catch (error) {
      next(error);
    }
  }

  /** GET /customer/addresses */
  static async getAddresses(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const addresses = await listAddresses(requireUserId(req));
      res.status(200).json({ success: true, data: { addresses } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /customer/addresses — body validated by addAddressSchema; pincode must be serviceable */
  static async addAddress(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const address = await createAddress(requireUserId(req), validatedBody(res, addAddressSchema));
      res.status(201).json({ success: true, message: 'Address saved successfully.', data: { address } });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /customer/addresses/:id — body validated by updateAddressSchema */
  static async updateAddress(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const address = await updateAddress(requireUserId(req), getParam(req, 'id'), validatedBody(res, updateAddressSchema));
      res.status(200).json({ success: true, message: 'Address updated successfully.', data: { address } });
    } catch (error) {
      next(error);
    }
  }

  /** PATCH /customer/addresses/:id/default */
  static async setDefaultAddress(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const address = await setDefaultAddress(requireUserId(req), getParam(req, 'id'));
      res.status(200).json({ success: true, message: 'Default address updated successfully.', data: { address } });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /customer/addresses/:id */
  static async deleteAddress(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await deleteAddress(requireUserId(req), getParam(req, 'id'));
      res.status(200).json({ success: true, message: 'Address deleted successfully.' });
    } catch (error) {
      next(error);
    }
  }

  /** GET /customer/favorites */
  static async getFavorites(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await listFavorites(requireUserId(req));
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /** POST /customer/favorites and /customer/favorites/:productId */
  static async addFavorite(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = requireUserId(req);
      const favorite = await addFavorite(userId, req.params.productId || req.body?.productId);
      res.status(201).json({
        success: true,
        message: 'Product added to favourites successfully.',
        data: { id: favorite.id, productId: favorite.productId },
      });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /customer/favorites/:productId */
  static async removeFavorite(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = requireUserId(req);
      await removeFavorite(userId, req.params.productId || req.body?.productId);
      res.status(200).json({ success: true, message: 'Product removed from favourites successfully.' });
    } catch (error) {
      next(error);
    }
  }

  /** GET /customer/delivery-settings (public) */
  /** GET /customer/store-timings?fulfillmentType=&addressId=&storeId= — when the order would be served (D-015) */
  static async getStoreTimings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await getCustomerAvailability(requireUserId(req), {
        fulfillmentType: queryString(req.query.fulfillmentType),
        addressId: queryString(req.query.addressId),
        storeId: queryString(req.query.storeId),
      });
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  static async getDeliverySettings(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const fares = await loadFareSettings(prisma);
      res.status(200).json({
        success: true,
        data: {
          deliveryEnabled: fares.deliveryEnabled,
          deliveryFee: fares.deliveryFee,
          freeDeliveryThreshold: fares.freeDeliveryThreshold,
          minimumOrderAmount: fares.minimumOrderAmount,
          // COD rules (D-009) so checkout can offer Pay On Delivery only when the order qualifies;
          // the backend still enforces them when the order is placed.
          codEnabled: fares.codEnabled,
          codCharge: fares.codCharge,
          minimumCodOrderAmount: fares.minimumCodOrderAmount,
          maximumCodOrderAmount: fares.maximumCodOrderAmount,
          // Online payment (UPI/cards via Cashfree) is offered only when the gateway is configured
          onlinePaymentAvailable: isOnlinePaymentConfigured(),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /customer/pincodes (public) — `pincodes` duplicated at top level for existing clients */
  static async getSupportedPincodes(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const pincodes = await listActivePincodes();
      res.status(200).json({ success: true, data: pincodes, pincodes });
    } catch (error) {
      next(error);
    }
  }

  /** GET /customer/serviceability/check?pincode=XXXXXX (public) */
  static async checkPincodeServiceability(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { pincode } = req.query;
      if (typeof pincode !== 'string' || !/^\d{6}$/.test(pincode.trim())) {
        res.status(400).json({ success: false, message: 'A valid 6-digit pincode is required.', errorCode: 'INVALID_PINCODE' });
        return;
      }
      res.status(200).json({ success: true, data: await checkPincode(pincode.trim()) });
    } catch (error) {
      next(error);
    }
  }
}
