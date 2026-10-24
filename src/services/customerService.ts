import { prisma } from '../config/db';
import { AppError } from '../utils/errors';

/** Customer profile fields returned to the app (never tokens or internal flags beyond isActive). */
const PROFILE_SELECT = {
  id: true,
  phone: true,
  name: true,
  email: true,
  dob: true,
  gender: true,
  avatarId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Active customer's profile; 404 USER_NOT_FOUND when missing or deactivated. */
export async function getCustomerProfile(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
  if (!user || !user.isActive) {
    throw new AppError(404, 'USER_NOT_FOUND', 'Customer not found or account is deactivated.');
  }
  return user;
}

export interface ProfileUpdate {
  name?: string;
  email?: string | null;
  dob?: Date | null;
  gender?: string | null;
  avatarId?: string | null;
}

/** Applies only the provided fields (already validated/normalised by updateProfileSchema). */
export async function updateCustomerProfile(userId: string, changes: ProfileUpdate) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.email !== undefined ? { email: changes.email } : {}),
      ...(changes.dob !== undefined ? { dob: changes.dob } : {}),
      ...(changes.gender !== undefined ? { gender: changes.gender } : {}),
      ...(changes.avatarId !== undefined ? { avatarId: changes.avatarId } : {}),
    },
    select: PROFILE_SELECT,
  });
}
