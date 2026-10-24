import { prisma } from '../config/db';
import { AppError } from '../utils/errors';

/** Customer favourites (P2-01 service extraction). Inactive products are hidden from the list. */
export async function listFavorites(userId: string) {
  const favorites = await prisma.favorite.findMany({
    where: { userId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          mrp: true,
          unit: true,
          minQuantity: true,
          maxQuantity: true,
          quantityStep: true,
          imageUrl: true,
          categoryId: true,
          isActive: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const active = favorites.filter((f) => f.product.isActive);
  return {
    productIds: active.map((f) => f.productId),
    favorites: active.map((f) => ({ id: f.id, productId: f.productId, product: f.product })),
  };
}

const requireProductId = (productId: unknown): string => {
  if (typeof productId !== 'string' || !productId) {
    throw new AppError(400, 'MISSING_PRODUCT_ID', 'Product ID is required.');
  }
  return productId;
};

/** Idempotently favourites an active product. */
export async function addFavorite(userId: string, rawProductId: unknown) {
  const productId = requireProductId(rawProductId);
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found or currently unavailable.');
  }
  return prisma.favorite.upsert({
    where: { userId_productId: { userId, productId } },
    create: { userId, productId },
    update: {},
  });
}

/** Idempotently removes a favourite (no error when it does not exist). */
export async function removeFavorite(userId: string, rawProductId: unknown) {
  const productId = requireProductId(rawProductId);
  await prisma.favorite.deleteMany({ where: { userId, productId } });
}
