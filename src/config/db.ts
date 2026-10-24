import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

/**
 * Database sessions use UTC. The adapter sends timestamps without an offset, so Postgres reads
 * them in the session time zone: with a non-UTC server zone (e.g. Asia/Kolkata) every stored
 * time was shifted by that offset (the API still looked right because reads shifted back).
 */
export const PG_SESSION_OPTIONS = '-c TimeZone=UTC';

// The adapter owns its pg pool, so prisma.$disconnect() also closes the pool's connections
// (an external Pool is left open by $disconnect, which leaked connections per test file).
const adapter = new PrismaPg({ connectionString, options: PG_SESSION_OPTIONS });

export const prisma = new PrismaClient({ adapter });

export async function connectDb() {
  try {
    await prisma.$connect();
    console.log('PostgreSQL database connected successfully via Prisma Pg Adapter.');

    // Ensure initial delivery pincodes exist if table is empty
    const pincodeCount = await prisma.supportedPincode.count();
    if (pincodeCount === 0) {
      await prisma.supportedPincode.createMany({
        data: [
          { pincode: '360001', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360002', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360003', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360004', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360005', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360006', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360007', city: 'Rajkot', state: 'Gujarat', isActive: true },
        ],
      });
      console.log('Seeded initial supported pincodes (360001-360007).');
    }
  } catch (error) {
    console.error('Failed to connect to the database:', error);
    // P3-05: library code does not exit the process; the caller (server.ts) decides.
    throw error;
  }
}

/** Closes the Prisma client and its pg pool (used during graceful shutdown). */
export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
