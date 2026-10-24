# Backend — Claude Code Conventions

Read root `/CLAUDE.md` and `docs/DECISIONS.md` first. `backend/README.md` and `docs/implementation_plan.md` are reference material, not decisions.

## Stack (current)
Node.js + TypeScript, Express 5, Prisma 7 (PostgreSQL via `@prisma/adapter-pg`), jsonwebtoken, bcryptjs, firebase-admin, Jest + Supertest (`@swc/jest`).

## Commands
```
npm run dev       # tsx watch src/server.ts (default port 5001)
npm run build     # tsc
npm test          # jest --runInBand (needs test PostgreSQL DATABASE_URL)
npm run db:seed
npm run e2e:admin # every admin panel feature against a running local server on a throwaway DB (ADMIN_E2E_API)
```

## Structure
```
src/app.ts            route mounting, 404, global error handler
src/routes/*.ts       URL → middleware → controller
src/controllers/*.ts  request handling + business logic (static class methods)
src/middlewares/      authenticate, requireRole, requireStoreAccess
src/services/         payments/ (Cashfree client, payment service), sms/ (MSG91 OTP delivery), superAdmin, otp, notification, pricing, inventory, order, adminOrder (status rules, pickup), manager, cart, session, customer (profile), address, favorite, serviceability
                      controllers stay thin: requireUserId/validatedBody → service → response; services throw AppError
src/validation/       request body schemas + validator (use validateBody(schema) in routes)
src/utils/            jwt, distance (Haversine), orderNumber
src/config/           db (Prisma client), validateEnv
prisma/               schema.prisma, migrations/, seed.ts
tests/*.test.ts       Jest + Supertest
```
- All routes under `/api/v1/<resource>`; admin under `/api/v1/admin`.
- Follow the existing controller pattern; new shared logic can go in `services/`.

## API conventions
- Success: `{ success: true, message?, data }`. Error: `{ success: false, message, errorCode }` with proper HTTP status.
- `errorCode` is SCREAMING_SNAKE_CASE and stable (clients depend on it, e.g. `NO_DELIVERY_AVAILABLE`, `COD_DISABLED`). Don't rename existing codes.
- Don't break existing response shapes used by the customer app/admin without coordinating.

## Data & business logic
- Server is authoritative for prices, totals, fees, stock, store assignment, and status transitions.
- Multi-step writes (orders, inventory, payments) must use `prisma.$transaction`; keep stock CAS + `InventoryTransaction` logging.
- Fees/COD values come from `DeliverySettings`; don't hard-code new business values.
- Store isolation: STORE_MANAGER may only access its own store; enforce in middleware **and** controller queries.
- Admin mutations should write `AuditLog`.

## Prisma
- **Do not modify `schema.prisma` or migrations without explicit approval.**
- Approved changes: `npx prisma migrate dev --name <desc>`; never edit applied migrations; never run `migrate reset`/`db push` against shared DBs.

## Undecided areas — ask first
Payment rules beyond D-020/D-022 (Cashfree; `src/services/payments/`, `docs/CASHFREE_PLAN.md`), OTP length, notification provider, pickup scope, maps/location, serviceability model. See `docs/DECISIONS.md` Pending. New payment schema changes and SDKs still need owner approval.

## Security
- Secrets from env only. Don't add new fallback secrets; flag any you find rather than relying on them.
- Never log tokens, passwords, payment signatures, or OTPs outside the dev mock.
- Validate and sanitize all input with a `validation/schemas.ts` schema + `validateBody` (keep existing errorCodes); check ownership (`userId`) on customer resources.
- Payment status changes only after server-side signature verification.

## Testing
- Every endpoint/behavior change needs Jest + Supertest coverage in `tests/`.
- Use a dedicated test database; tests run with `NODE_ENV=test` (mock OTP `1234`).
- Never delete, skip, or weaken tests.
