import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/errors';
import { PageParams, paginationMeta } from '../utils/pagination';

/**
 * Store manager accounts (SUPER_ADMIN only; P2-01 service extraction).
 * A manager is an AdminUser with role STORE_MANAGER assigned to one store (StoreManager row).
 * Every mutation writes AuditLog entries in the same transaction.
 */

const BCRYPT_ROUNDS = 10;

const MANAGER_NOT_FOUND = () => new AppError(404, 'MANAGER_NOT_FOUND', 'Store Manager not found.');
const STORE_NOT_FOUND = () => new AppError(400, 'STORE_NOT_FOUND', 'Assigned store does not exist.');
const DUPLICATE_EMAIL = () => new AppError(400, 'DUPLICATE_EMAIL', 'A user with this email address already exists.');

const WITH_STORE = { managers: { include: { store: true } } } as const;
type ManagerWithStore = Prisma.AdminUserGetPayload<{ include: typeof WITH_STORE }>;

/** API shape shared by every manager endpoint (no password hash). */
function toManagerSummary(manager: ManagerWithStore) {
  const assignment = manager.managers[0];
  return {
    id: manager.id,
    name: manager.name,
    email: manager.email,
    role: manager.role,
    isActive: manager.isActive,
    storeId: assignment ? assignment.store.id : null,
    storeIdString: assignment ? assignment.store.storeId : null,
    storeName: assignment ? assignment.store.name : null,
  };
}

const withTimestamps = (manager: ManagerWithStore) => ({
  ...toManagerSummary(manager),
  createdAt: manager.createdAt,
  updatedAt: manager.updatedAt,
});

async function requireStore(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw STORE_NOT_FOUND();
  return store;
}

async function assertEmailAvailable(email: string) {
  if (await prisma.adminUser.findUnique({ where: { email } })) throw DUPLICATE_EMAIL();
}

async function findManager(id: string) {
  const manager = await prisma.adminUser.findUnique({ where: { id }, include: WITH_STORE });
  if (!manager || manager.role !== 'STORE_MANAGER') throw MANAGER_NOT_FOUND();
  return manager;
}

// ---------- Queries ----------

export interface ManagerListQuery {
  search?: string;
  storeId?: string;
  isActive?: string;
}

/** Managers ordered by name; `{ managers, pagination }` when paged, else a plain array (existing contract). */
export async function listManagers(query: ManagerListQuery, paging: PageParams | null) {
  const where: Prisma.AdminUserWhereInput = { role: 'STORE_MANAGER' };
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.isActive !== undefined) where.isActive = query.isActive === 'true';
  if (query.storeId) where.managers = { some: { storeId: query.storeId } };

  const [managers, total] = await Promise.all([
    prisma.adminUser.findMany({
      where,
      include: WITH_STORE,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      ...(paging ? { skip: paging.skip, take: paging.limit } : {}),
    }),
    paging ? prisma.adminUser.count({ where }) : Promise.resolve(0),
  ]);

  const mapped = managers.map(withTimestamps);
  return paging ? { managers: mapped, pagination: paginationMeta(total, paging) } : mapped;
}

/** Manager details including the assigned store's address. */
export async function getManager(id: string) {
  const manager = await findManager(id);
  return { ...withTimestamps(manager), storeAddress: manager.managers[0]?.store.address ?? null };
}

// ---------- Mutations ----------

export interface NewManager {
  name: string;
  email: string;
  password: string;
  storeId: string;
  isActive?: boolean;
}

/** Creates a STORE_MANAGER account assigned to an existing store. */
export async function createManager(actorId: string | undefined, input: NewManager) {
  const store = await requireStore(input.storeId);
  await assertEmailAvailable(input.email);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const created = await prisma.$transaction(async (tx) => {
    const admin = await tx.adminUser.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        role: 'STORE_MANAGER',
        isActive: input.isActive ?? true,
      },
    });
    await tx.storeManager.create({ data: { adminUserId: admin.id, storeId: store.id } });
    await tx.auditLog.create({
      data: {
        adminUserId: actorId,
        action: 'MANAGER_CREATED',
        details: `Created Store Manager account for: ${input.name} (${input.email}) assigned to store ${store.storeId}`,
      },
    });
    return admin;
  });

  return toManagerSummary({ ...created, managers: [{ store } as ManagerWithStore['managers'][number]] });
}

export interface ManagerChanges {
  name?: string;
  email?: string;
  password?: string;
  storeId?: string;
  isActive?: boolean;
}

/** Updates profile fields, password, active flag and/or store assignment (audited). */
export async function updateManager(actorId: string | undefined, id: string, changes: ManagerChanges) {
  const manager = await findManager(id);
  if (changes.email && changes.email !== manager.email) await assertEmailAvailable(changes.email);
  const targetStore = changes.storeId ? await requireStore(changes.storeId) : null;
  const passwordHash = changes.password ? await bcrypt.hash(changes.password, BCRYPT_ROUNDS) : undefined;

  await prisma.$transaction(async (tx) => {
    const updated = await tx.adminUser.update({
      where: { id },
      data: { name: changes.name, email: changes.email, passwordHash, isActive: changes.isActive },
    });

    const current = manager.managers[0] ?? null;
    if (targetStore && (!current || current.storeId !== targetStore.id)) {
      await tx.storeManager.deleteMany({ where: { adminUserId: id } });
      await tx.storeManager.create({ data: { adminUserId: id, storeId: targetStore.id } });
      await tx.auditLog.create({
        data: {
          adminUserId: actorId,
          action: 'MANAGER_STORE_CHANGED',
          details: `Reassigned Store Manager ${updated.name} from store ID ${current ? current.storeId : 'NONE'} to store ID ${targetStore.id}`,
        },
      });
    }

    if (changes.isActive !== undefined && changes.isActive !== manager.isActive) {
      await tx.auditLog.create({
        data: {
          adminUserId: actorId,
          action: changes.isActive ? 'MANAGER_ACTIVATED' : 'MANAGER_DEACTIVATED',
          details: `${changes.isActive ? 'Activated' : 'Deactivated'} Store Manager: ${updated.name} (${updated.email})`,
        },
      });
    }

    // A new password or deactivation ends existing sessions (refresh tokens).
    if (passwordHash || changes.isActive === false) {
      await tx.refreshToken.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }

    await tx.auditLog.create({
      data: { adminUserId: actorId, action: 'MANAGER_UPDATED', details: `Updated details for Store Manager: ${updated.name}` },
    });
  });

  return toManagerSummary(await findManager(id));
}
