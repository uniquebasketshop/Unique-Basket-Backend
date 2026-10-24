import { prisma } from '../../src/config/db';

/**
 * Each test file gets its own Prisma client and pg pool (Jest module registry per file).
 * Close it after the file so connections don't pile up across the suite. Safe to repeat:
 * files that already disconnect are unaffected, and Prisma reconnects if used again.
 */
afterAll(async () => {
  await prisma.$disconnect();
});
