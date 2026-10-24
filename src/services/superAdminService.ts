import bcrypt from 'bcryptjs';
import { prisma } from '../config/db';
import { AppError } from '../utils/errors';
import { isStrongStaffPassword, isValidEmail } from '../validation/schemas';

const BCRYPT_ROUNDS = 10;

export interface NewSuperAdmin {
  email: string;
  name: string;
  password: string;
}

/**
 * Creates a Super Admin account without touching any other data (the seed is never run on a
 * live database). Refuses when a Super Admin already exists unless `allowAdditional` is set,
 * so running it twice by mistake does nothing. Writes an audit log entry.
 */
export async function createSuperAdmin(input: NewSuperAdmin, options: { allowAdditional?: boolean } = {}) {
  const email = input.email?.trim().toLowerCase() ?? '';
  const name = input.name?.trim() ?? '';
  const password = input.password ?? '';

  if (!isValidEmail(email) || email.length > 100) {
    throw new AppError(400, 'INVALID_EMAIL', 'A valid email (max 100 characters) is required.');
  }
  if (!name || name.length > 100) {
    throw new AppError(400, 'INVALID_NAME', 'A name (max 100 characters) is required.');
  }
  if (!isStrongStaffPassword(password)) {
    throw new AppError(400, 'WEAK_PASSWORD', 'Password must be 8 to 72 characters and include at least one letter and one number.');
  }

  if (await prisma.adminUser.findUnique({ where: { email } })) {
    throw new AppError(409, 'DUPLICATE_EMAIL', 'An admin account with this email already exists.');
  }
  if (!options.allowAdditional && (await prisma.adminUser.count({ where: { role: 'SUPER_ADMIN' } })) > 0) {
    throw new AppError(409, 'SUPER_ADMIN_EXISTS', 'A Super Admin already exists. Use --allow-additional to add another one.');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  return prisma.$transaction(async (tx) => {
    const admin = await tx.adminUser.create({
      data: { email, name, passwordHash, role: 'SUPER_ADMIN', isActive: true },
      select: { id: true, email: true, name: true, role: true },
    });
    await tx.auditLog.create({
      data: { adminUserId: admin.id, action: 'CREATE_SUPER_ADMIN', details: `Super Admin created from the command line: ${email}` },
    });
    return admin;
  });
}
