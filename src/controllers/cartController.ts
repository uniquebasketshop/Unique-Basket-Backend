import { Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { validateProductQuantity } from '../utils/quantity';
import { validatedBody } from '../middlewares/validate';
import { addCartItemSchema, updateCartItemSchema } from '../validation/schemas';
import { getCartSummary } from '../services/cartService';
import { getParam } from '../utils/request';

export class CartController {
  /**
   * Fetch current user's cart items and subtotal.
   */
  static async getCart(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({
          success: false,
          message: 'Unauthorized.',
          errorCode: 'UNAUTHORIZED',
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: await getCartSummary(userId, req.query.fulfillmentType === 'PICKUP' ? 'PICKUP' : 'DELIVERY'),
      });
    } catch (error) {
      next(error);
    }
  }


  /**
   * Add item to cart (supports decimal quantity).
   */
  static async addItem(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;
      // Shape validated by validateBody(addCartItemSchema); product quantity rules are checked below.
      const { productId, quantity: targetQty } = validatedBody(res, addCartItemSchema);

      if (!userId) {
        res.status(401).json({
          success: false,
          message: 'Unauthorized.',
          errorCode: 'UNAUTHORIZED',
        });
        return;
      }

      // Check product is active and its category is active
      const product = await prisma.product.findUnique({
        where: { id: productId },
        include: { category: true },
      });

      if (!product || !product.isActive || !product.category.isActive) {
        res.status(404).json({
          success: false,
          message: 'Product not found or currently unavailable.',
          errorCode: 'PRODUCT_UNAVAILABLE',
        });
        return;
      }

      const quantityError = validateProductQuantity(product, targetQty);
      if (quantityError) {
        res.status(400).json({
          success: false,
          message: quantityError,
          errorCode: 'INVALID_QUANTITY',
        });
        return;
      }

      // Upsert cart item
      const cartItem = await prisma.cartItem.upsert({
        where: {
          userId_productId: { userId, productId },
        },
        update: {
          quantity: targetQty,
        },
        create: {
          userId,
          productId,
          quantity: targetQty,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Product added to cart successfully.',
        data: {
          id: cartItem.id,
          productId: cartItem.productId,
          quantity: Number(cartItem.quantity),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update cart item quantity.
   */
  static async updateItem(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;
      const id = getParam(req, 'id');
      // validateBody(updateCartItemSchema): quantity is a number; 0 or less removes the line.
      const { quantity: targetQty } = validatedBody(res, updateCartItemSchema);

      if (!userId) {
        res.status(401).json({
          success: false,
          message: 'Unauthorized.',
          errorCode: 'UNAUTHORIZED',
        });
        return;
      }


      const cartItem = await prisma.cartItem.findUnique({
        where: { id },
        include: { product: { select: { unit: true, minQuantity: true, maxQuantity: true, quantityStep: true } } },
      });

      if (!cartItem || cartItem.userId !== userId) {
        res.status(404).json({
          success: false,
          message: 'Cart item not found.',
          errorCode: 'CART_ITEM_NOT_FOUND',
        });
        return;
      }

      if (targetQty <= 0) {
        // If quantity is 0 or less, remove item
        await prisma.cartItem.delete({
          where: { id },
        });

        res.status(200).json({
          success: true,
          message: 'Cart item removed.',
        });
        return;
      }

      const quantityError = validateProductQuantity(cartItem.product, targetQty);
      if (quantityError) {
        res.status(400).json({
          success: false,
          message: quantityError,
          errorCode: 'INVALID_QUANTITY',
        });
        return;
      }

      const updated = await prisma.cartItem.update({
        where: { id },
        data: { quantity: targetQty },
      });

      res.status(200).json({
        success: true,
        message: 'Cart updated successfully.',
        data: {
          id: updated.id,
          productId: updated.productId,
          quantity: Number(updated.quantity),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Remove cart item.
   */
  static async removeItem(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;
      const id = getParam(req, 'id');

      if (!userId) {
        res.status(401).json({
          success: false,
          message: 'Unauthorized.',
          errorCode: 'UNAUTHORIZED',
        });
        return;
      }

      const cartItem = await prisma.cartItem.findUnique({
        where: { id },
      });

      if (!cartItem || cartItem.userId !== userId) {
        res.status(404).json({
          success: false,
          message: 'Cart item not found.',
          errorCode: 'CART_ITEM_NOT_FOUND',
        });
        return;
      }

      await prisma.cartItem.delete({
        where: { id },
      });

      res.status(200).json({
        success: true,
        message: 'Cart item removed.',
      });
    } catch (error) {
      next(error);
    }
  }
}
