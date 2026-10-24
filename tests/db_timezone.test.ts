import { prisma } from '../src/config/db';

/**
 * Times must be stored as real UTC instants regardless of the database server's time zone
 * (the local server here uses Asia/Kolkata, which shifted every stored time by 5h30).
 */
describe('Database time zone', () => {
  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { action: 'TZ_CHECK' } });
    await prisma.$disconnect();
  });

  it('uses UTC for database sessions', async () => {
    const rows = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(rows[0].tz).toEqual('UTC');
  });

  it('stores the exact instant given, as Postgres itself sees it', async () => {
    const at = new Date('2026-10-11T07:20:24.437Z'); // 12:50:24 IST
    const row = await prisma.auditLog.create({ data: { action: 'TZ_CHECK', details: 'tz', createdAt: at } });

    const raw = await prisma.$queryRaw<{ epoch_ms: number; ist: string }[]>`
      SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::float8 AS epoch_ms,
             to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS ist
      FROM audit_logs WHERE id = ${row.id}::uuid`;
    expect(Math.round(Number(raw[0].epoch_ms))).toEqual(at.getTime());
    expect(raw[0].ist).toEqual('12:50:24');

    const read = await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(read.createdAt.toISOString()).toEqual(at.toISOString());
  });

  it("matches the database's own clock for new rows", async () => {
    const row = await prisma.auditLog.create({ data: { action: 'TZ_CHECK', details: 'now' } });
    const raw = await prisma.$queryRaw<{ diff_s: number }[]>`
      SELECT ABS(EXTRACT(EPOCH FROM (now() - created_at)))::float8 AS diff_s FROM audit_logs WHERE id = ${row.id}::uuid`;
    expect(Number(raw[0].diff_s)).toBeLessThan(60);
  });
});
