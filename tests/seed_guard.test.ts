import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { prisma } from '../src/config/db';

// P0-07: the destructive seed must refuse to run outside development/test.
describe('Seed script guard (P0-07)', () => {
  const backendRoot = path.resolve(__dirname, '..');

  const runSeed = (nodeEnv: string | undefined, extraEnv: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    if (nodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = nodeEnv;
    }
    // Run outside the backend folder so the seed's dotenv.config() can't load the local .env:
    // its NODE_ENV=development would turn the "unset" case into a real seed run that wipes the
    // test database (and its DATABASE_URL could point at the dev database).
    return spawnSync(path.join(backendRoot, 'node_modules', '.bin', 'tsx'), [path.join(backendRoot, 'prisma', 'seed.ts')], {
      cwd: os.tmpdir(),
      env,
      encoding: 'utf-8',
      timeout: 60000,
    });
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each([['production'], [undefined], ['staging']])(
    'refuses to run and leaves data untouched when NODE_ENV is %s',
    async (nodeEnv) => {
      const adminsBefore = await prisma.adminUser.count();
      const storesBefore = await prisma.store.count();
      const ordersBefore = await prisma.order.count();

      const result = runSeed(nodeEnv);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('[seed] Refusing to run');
      expect(result.stdout).not.toContain('Cleared existing records');

      expect(await prisma.adminUser.count()).toBe(adminsBefore);
      expect(await prisma.store.count()).toBe(storesBefore);
      expect(await prisma.order.count()).toBe(ordersBefore);
    },
    90000
  );

  // Second guard: even with NODE_ENV=test, a non-local database is refused unless confirmed by name.
  it.each([
    ['a remote database', { DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/unique_basket_prod' }],
    [
      'a remote database confirmed with the wrong name',
      { DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/unique_basket_prod', SEED_CONFIRM_DATABASE: 'other_db' },
    ],
    ['a URL without a database name', { DATABASE_URL: 'postgresql://user:pass@localhost:5432' }],
    ['an unparseable URL', { DATABASE_URL: 'not a url' }],
  ])(
    'refuses to run against %s',
    async (_label, extraEnv) => {
      const adminsBefore = await prisma.adminUser.count();

      const result = runSeed('test', extraEnv);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('[seed] Refusing to run');
      expect(result.stdout).not.toContain('Seeding database');
      expect(await prisma.adminUser.count()).toBe(adminsBefore);
    },
    90000
  );
});
