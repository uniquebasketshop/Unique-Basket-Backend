# UNIQUE BASKET Backend

The **UNIQUE BASKET Backend** is the core RESTful API service powering the UNIQUE BASKET multi-store grocery and hyper-local delivery platform. It serves the Customer Mobile Application (Flutter) and the Admin Web Dashboard (React/Vite).

---

## Overview

The backend is built with **Node.js**, **Express 5**, **TypeScript**, and **Prisma ORM** connecting to a **PostgreSQL** database. It provides multi-store catalog and inventory tracking, geofenced store discovery using the Haversine formula, OTP-based customer authentication, role-based admin management, end-to-end order processing workflows (with Delivery and Store Pickup modes), and Firebase Cloud Messaging (FCM) notifications.

---

## Features

- **Authentication & Authorization**:
  - Customer mobile authentication via OTP generation and verification.
  - Administrative authentication (Email/Password with `bcryptjs`) supporting `SUPER_ADMIN` and `STORE_MANAGER` roles.
  - JWT tokens (short-lived access tokens and refresh tokens) with store-level access isolation for store managers.
- **Store & Geofenced Discovery**:
  - Multi-store management with store operational timings and custom delivery radiuses.
  - Coordinate-based nearest store resolution using Haversine distance calculations.
- **Catalog & Store Inventory**:
  - Global product and category management with hierarchical display orders.
  - Per-store stock levels, low-stock threshold alerting, and transaction audit trails for stock changes.
- **Shopping Cart & Checkout**:
  - Persistent server-side cart for customer accounts with stock validation.
- **Order Lifecycle Management**:
  - Order workflows for Delivery and Pickup (Placed $\rightarrow$ Confirmed $\rightarrow$ Preparing $\rightarrow$ Ready for Pickup / Out for Delivery $\rightarrow$ Delivered / Picked Up).
  - OTP-based pickup verification at store counters.
  - Automated inventory deduction on placement and restoration on cancellation.
- **Payments**:
  - Online payments: Cashfree is the chosen provider (docs/DECISIONS.md D-020); integration is planned in `docs/CASHFREE_PLAN.md`. ONLINE orders are currently created unpaid.
  - Cash on Delivery (COD) with configurable threshold limits and fees.
- **System Settings & Fare Rules**:
  - Configurable delivery fees, free delivery thresholds, minimum order values, and COD charges.
- **Marketing Banners & Audit Logs**:
  - Promotional banner management and administrative activity audit logging.
- **Push Notifications**:
  - Firebase Cloud Messaging integration for order status updates with graceful simulation fallback when unconfigured.

---

## Tech Stack

| Technology | Purpose |
| :--- | :--- |
| **Node.js** (v18+) | Server-side JavaScript runtime environment |
| **TypeScript** (v6.0) | Static type safety and developer tooling |
| **Express** (v5.2) | Web framework and HTTP routing layer |
| **Prisma ORM** (v7.9) | Database modeling, migrations, and typed querying |
| **PostgreSQL** | Relational database engine |
| **JSON Web Tokens (JWT)** | Stateless authentication tokens |
| **bcryptjs** | Password hashing for administrative accounts |
| **Firebase Admin SDK** | Push notifications via Firebase Cloud Messaging (FCM) |
| **Jest & Supertest** | Automated unit and integration testing suite |
| **TSX** | TypeScript execution and development file watching |

---

## Architecture

The backend follows a modular, layered MVC-style architecture:

```text
backend/
├── prisma/
│   ├── migrations/          # SQL migration history
│   ├── schema.prisma        # Prisma data models and relations
│   └── seed.ts              # Database seeding script for development
├── src/
│   ├── config/              # Database (Prisma client) and third-party configs
│   ├── controllers/         # HTTP request handlers and business validation
│   ├── middlewares/         # JWT authentication, role check, and store isolation
│   ├── routes/              # Express API route declarations grouped by resource
│   ├── services/            # Business services (OTP handling, FCM notifications)
│   ├── utils/               # Helper utilities (JWT tokens, Haversine distance)
│   ├── app.ts               # Express application initialization and middleware
│   └── server.ts            # HTTP server startup and database connection
├── tests/                   # Automated Jest integration test suites
├── jest.config.js           # Jest and SWC test configuration
├── package.json             # Dependencies and project scripts
├── prisma.config.ts         # Prisma configuration
└── tsconfig.json            # TypeScript compiler configuration
```

### Request Flow
$$\text{HTTP Request} \longrightarrow \text{Express App} \longrightarrow \text{Middleware (CORS, JSON, Auth/Role)} \longrightarrow \text{Controller} \longrightarrow \text{Prisma ORM / Services} \longrightarrow \text{PostgreSQL}$$

---

## Prerequisites

- **Node.js**: `v18.0.0` or higher (LTS recommended)
- **Package Manager**: `npm` (v9+)
- **Database**: `PostgreSQL` (v14+) running locally or hosted

---

## Installation & Setup

1. **Navigate to the backend directory**:
   ```bash
   cd backend
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   Copy `backend/.env.example` to `backend/.env` and fill in values (see [Environment Configuration](#environment-configuration)).

4. **Generate Prisma Client and apply migrations**:
   ```bash
   npx prisma generate
   npx prisma migrate deploy
   ```
   Never use `prisma db push` on shared databases: it changes the schema without creating a
   migration, which is how migration drift happened before. Create schema changes with
   `npx prisma migrate dev --name <change>` and commit the generated migration.

   After pulling changes that add migrations, run `npx prisma migrate deploy` and
   `npx prisma generate` (`npm install` also runs `prisma generate` via `postinstall`), then
   restart the server. A stale client fails at runtime with errors like
   `Cannot read properties of undefined (reading 'create')`.

5. **Seed initial development data (Optional, development/test only)**:
   ```bash
   NODE_ENV=development npm run db:seed
   ```
   The seed **deletes all data** and refuses to run unless `NODE_ENV` is `development` or `test` and the database is on this machine (or named in `SEED_CONFIRM_DATABASE`).

---

## Environment Configuration

The application reads configuration from `backend/.env`. Below are the required and optional environment variables:

| Variable | Required | Description | Safe Example Placeholder |
| :--- | :---: | :--- | :--- |
| `PORT` | Optional | Port for the HTTP server (defaults to `5001`) | `5001` |
| `NODE_ENV` | **Required for local dev** | `development`, `test` or `production`. A missing/unknown value is treated as production (no `1234` OTP bypass, strict secret checks). | `development` |
| `OTP_BYPASS_ENABLED` | Optional (dev/test) | `true` turns on the static OTP `1234`, only when `NODE_ENV` is `development`/`test`. The server refuses to start with it outside development/test. | `true` |
| `DATABASE_URL` | **Required** | PostgreSQL connection string | `postgresql://user:password@localhost:5432/unique_basket?schema=public` |
| `JWT_SECRET` | **Required** | Secret for access tokens (15m). Server refuses to start without it; outside development/test it must be ≥ 32 characters. | `your_jwt_access_secret_key` |
| `JWT_REFRESH_SECRET` | **Required** | Secret for refresh tokens (7d, server-side revocable sessions). Same rules; must differ from `JWT_SECRET` in production. | `your_jwt_refresh_secret_key` |
| `FIREBASE_SERVICE_ACCOUNT` | Optional | Stringified JSON of Firebase Admin Service Account | `{"type":"service_account",...}` |
| `CORS_ORIGINS` | **Required in production for the admin panel** | Comma-separated browser origins allowed to call the API. Unset: any origin in development/test, none in production. | `https://admin.example.com` |
| `TRUST_PROXY` | Optional | Reverse-proxy hops in front of the API (`1`, `true`, …) so client IPs are correct for rate limiting/logs | `1` |
| `BODY_LIMIT` | Optional | Max JSON/form body size (default `100kb`) | `100kb` |
| `SEED_SUPER_ADMIN_PASSWORD` / `SEED_MANAGER_PASSWORD` | Optional | Passwords for the dev/test seed admin accounts (defaults are well-known dev values) | `choose_a_local_password` |
| `SEED_CONFIRM_DATABASE` | Optional | The seed (which wipes all data) refuses a non-local database unless this equals its name | `unique_basket_staging` |
| `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET` | Optional | Cashfree App ID and Secret Key (dashboard → Developers → API Keys). Empty = online payment off (cash only). Never in the app or git. | (from Cashfree) |
| `CASHFREE_ENV` | With Cashfree | `sandbox` while testing, `production` with live keys (required outside development/test) | `sandbox` |
| `CASHFREE_API_VERSION` | Optional | Cashfree API version header | `2023-08-01` |
| `PUBLIC_API_BASE_URL` | Production with Cashfree | Public `https://` address of this API; Cashfree sends webhooks to `<url>/api/v1/payments/webhook/cashfree` | `https://api.uniquebasket.com` |

> Payment and Firebase variables belong to integrations whose providers are still undecided (see `docs/DECISIONS.md`). No maps/geocoding key is used by the code.

> [!CAUTION]
> Never commit `.env` or files containing live credentials, passwords, or secret keys to version control.

---

## Running the Backend

The following scripts are defined in `package.json`:

```bash
# Start development server with live reload (via tsx)
npm run dev

# Compile TypeScript source code to dist/
npm run build

# Start the compiled production build
npm start

# Seed the database with sample products, stores, and admin accounts
npm run db:seed

# Run the automated Jest test suite
npm test
```

---

## API Endpoints

**Base URL**: `http://localhost:5001/api/v1`

### 1. Health Check
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Server health check and timestamp | None |

### 2. Authentication (`/api/v1/auth`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/send-otp` | Request OTP for customer phone login | None |
| `POST` | `/verify-otp` | Verify customer OTP and issue JWT | None |
| `POST` | `/refresh` | Refresh expired access token (refresh token must belong to a live session) | None |
| `POST` | `/logout` | Revoke the refresh session given as `refreshToken` (idempotent) | None |

`send-otp`, `verify-otp`, `refresh` and `POST /admin/login` are rate limited (429 `RATE_LIMITED`).

### 3. Admin Operations (`/api/v1/admin`)
| Method | Endpoint | Description | Role Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/login` | Admin email/password login | None |
| `GET` | `/orders` | List orders (filtered by store for managers) | `SUPER_ADMIN`, `STORE_MANAGER` |
| `GET` | `/orders/:id` | Get detailed order summary | `SUPER_ADMIN`, `STORE_MANAGER` |
| `PUT` | `/orders/:id/status` | Advance order status | `SUPER_ADMIN`, `STORE_MANAGER` |
| `POST` | `/orders/pickup-verify` | Verify pickup OTP and complete order | `SUPER_ADMIN`, `STORE_MANAGER` |
| `GET` | `/payments` | List payment transactions | `SUPER_ADMIN`, `STORE_MANAGER` |
| `GET` | `/payments/:id` | Get payment transaction details | `SUPER_ADMIN`, `STORE_MANAGER` |
| `GET` | `/inventory/transactions` | Query inventory stock modification logs | `SUPER_ADMIN`, `STORE_MANAGER` |
| `GET` | `/stores` | List all stores | `SUPER_ADMIN`, `STORE_MANAGER` |
| `POST` | `/stores` | Create a new store | `SUPER_ADMIN` |
| `PUT` | `/stores/:id` | Update store metadata / radius | `SUPER_ADMIN` |
| `DELETE`| `/stores/:id` | Remove store | `SUPER_ADMIN` |
| `GET` | `/managers` | List store managers and assignments | `SUPER_ADMIN` |
| `POST` | `/managers` | Create manager and assign store | `SUPER_ADMIN` |
| `GET` | `/managers/:id` | Get manager details | `SUPER_ADMIN` |
| `PUT` | `/managers/:id` | Update manager details / assignment | `SUPER_ADMIN` |
| `GET` | `/customers` | List registered customer accounts | `SUPER_ADMIN` |
| `GET` | `/customers/:id` | Get customer details and order history | `SUPER_ADMIN` |
| `PUT` | `/customers/:id/status` | Activate or deactivate customer | `SUPER_ADMIN` |
| `GET` | `/settings/fare-cod` | Fetch system delivery fees and COD limits | `SUPER_ADMIN`, `STORE_MANAGER` |
| `PUT` | `/settings/fare-cod` | Update delivery fees and COD rules | `SUPER_ADMIN` |
| `GET` | `/audit-logs` | Query administrative audit logs | `SUPER_ADMIN` |
| `GET` | `/audit-logs/actions` | List distinct audit actions | `SUPER_ADMIN` |
| `GET` | `/banners` | List marketing promotional banners | `SUPER_ADMIN` |
| `POST` | `/banners` | Create promotional banner | `SUPER_ADMIN` |
| `PUT` | `/banners/:id` | Update promotional banner | `SUPER_ADMIN` |
| `DELETE`| `/banners/:id` | Delete promotional banner | `SUPER_ADMIN` |

### 4. Stores (`/api/v1/stores`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | List all available stores | Customer / Admin |
| `GET` | `/nearby` | Find closest store by latitude & longitude | Customer / Admin |
| `GET` | `/:id` | Get store details | Customer / Admin |

### 5. Categories & Products (`/api/v1/categories`, `/api/v1/products`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `GET` | `/categories` | List active catalog categories | Customer / Admin |
| `POST` | `/categories` | Create category | `SUPER_ADMIN` |
| `GET` | `/products` | List global products | Customer / Admin |
| `GET` | `/products/:id` | Get product details | Customer / Admin |
| `POST` | `/products` | Create global catalog product | `SUPER_ADMIN` |
| `GET` | `/products/store/:storeId` | List products with store stock levels | Customer / Admin |
| `PUT` | `/products/store/:storeId/inventory/:productId` | Adjust store inventory quantity | `SUPER_ADMIN`, `STORE_MANAGER` |

### 6. Cart & Orders (`/api/v1/cart`, `/api/v1/orders`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `GET` | `/cart` | Get current customer's cart | Customer |
| `POST` | `/cart/items` | Add or update item in cart | Customer |
| `PUT` | `/cart/items/:id` | Update cart item quantity | Customer |
| `DELETE`| `/cart/items/:id` | Remove item from cart | Customer |
| `POST` | `/orders` | Place order (Delivery or Pickup). Optional `Idempotency-Key` header (8–64 chars `A-Z a-z 0-9 _ -`): a repeat with the same key returns the existing order (200) instead of creating another | Customer |
| `GET` | `/orders` | List customer's order history | Customer |
| `GET` | `/orders/:id` | Get single order details | Customer |

### 7. Payments (`/api/v1/payments`) — Cashfree (D-020, D-022)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/payments/orders/:orderId/session` | Cashfree checkout session for an unpaid online order (first try or "Pay again") | Customer (own order) |
| `GET` | `/payments/orders/:orderId/status` | Checks with Cashfree, updates the order, returns the payment state | Customer (own order) |
| `POST` | `/payments/orders/:orderId/switch-to-cash` | "Pay with cash instead": COD / Pay at Store (COD rules and charge for delivery) | Customer (own order) |
| `POST` | `/payments/webhook/cashfree` | Cashfree notifications; HMAC signature + timestamp verified | Public (signed) |

`POST /orders` with `paymentMethod: ONLINE` returns `data.payment` (session) as well. A background job (every minute) cancels online orders unpaid after 15 minutes (stock restored) and retries/checks refunds. Store-cancelled paid orders are refunded automatically. Go-live steps: `docs/CASHFREE_PLAN.md`.

### First Super Admin on a live database
The seed never runs on a live database. Create the first Super Admin once with:
```bash
SUPER_ADMIN_EMAIL=owner@example.com SUPER_ADMIN_NAME="Owner" npm run admin:create
# asks for the password (hidden); 8–72 characters with a letter and a number
```
It only adds that account (plus an audit entry); it refuses if a Super Admin already exists (add `--allow-additional` for a second one). Use `npm run admin:create:dev` with tsx during development.

### 8. Notifications (`/api/v1/notifications`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/notifications/tokens` | Register FCM device token for push alerts | Customer / Admin |

---

## Authentication & Authorization

### Customer Authentication
1. Customer initiates login via `POST /api/v1/auth/send-otp` with their mobile number.
2. An OTP is generated with rate limiting (5 minutes expiry, 1-minute cooldown between requests).
3. The customer submits the code via `POST /api/v1/auth/verify-otp`.
4. On success, the API issues a signed JWT access token (`expiresIn: 15m`) and refresh token (`expiresIn: 7d`).

### Admin Authentication & Store Isolation
1. Admin users authenticate via `POST /api/v1/admin/login` using email and password.
2. The user is assigned an `AdminRole`:
   - `SUPER_ADMIN`: Full access across all stores, settings, managers, and global catalogs.
   - `STORE_MANAGER`: Restricted to viewing orders and updating inventory strictly for their assigned `storeId`. Attempting to access another store returns `403 Forbidden` (`STORE_ACCESS_FORBIDDEN`).

---

## Request & Response Conventions

### Success Response Format
```json
{
  "success": true,
  "message": "Operation completed successfully.",
  "data": {
    "orderId": "..."
  }
}
```

### Error Response Format
```json
{
  "success": false,
  "message": "Detailed description of error.",
  "errorCode": "INVALID_PARAMETERS"
}
```

---

## Database Models

The PostgreSQL schema managed by Prisma (`prisma/schema.prisma`) includes the following core entities:

- **User**: Customer accounts identified by phone number.
- **UserAddress**: Saved customer delivery addresses with coordinates.
- **AdminUser**: Administrators and Store Managers with hashed credentials and roles.
- **Store**: Store locations with delivery radius, operating hours, and coordinates.
- **StoreManager**: Relation mapping an `AdminUser` to an assigned `Store`.
- **Category & Product**: Catalog hierarchy, pricing, MRP, and product units (`KG`, `GRAM`, `PIECE`, `PACK`, `DOZEN`).
- **StoreInventory**: Stock levels and low-stock thresholds per store-product pair.
- **InventoryTransaction**: Audit history of stock increments, decrements, and order deductions.
- **Order & OrderItem**: Order details, fulfillment type (`DELIVERY` \| `PICKUP`), payment method (`COD` \| `ONLINE`), and status lifecycle.
- **Payment**: Payment-gateway records per order (columns still named `razorpay_*`; renamed in the Cashfree migration).
- **DeliverySettings**: Global system configurations for fares, thresholds, and COD limits.
- **Banner & AuditLog**: Marketing banners and admin activity audit trails.
- **CartItem**: Server-side cart management.
- **DeviceToken**: Device FCM tokens for push notification routing (`ANDROID`, `IOS`, `WEB`).

---

## Testing

The project includes an automated test suite using **Jest**, **SWC**, and **Supertest**.

Tests run against a real PostgreSQL database. Use a **dedicated test database** (never a shared or production one):

```bash
# 1. Point DATABASE_URL at an empty test database
export DATABASE_URL="postgresql://user:password@localhost:5432/unique_basket_test"

# 2. Apply migrations and seed test data (the seed only runs with NODE_ENV=development|test)
NODE_ENV=test npx prisma migrate deploy
NODE_ENV=test npx prisma db seed

# 3. Run all automated test suites
npm test
```

No other environment variables are needed. `tests/setup/env.ts` (loaded by `jest.config.js`) sets
`NODE_ENV=test` and test-only values for `JWT_SECRET` and `JWT_REFRESH_SECRET`. Values already present in the environment take precedence. The suite can be
re-run against the same database without reseeding.

Test suites cover:
- Customer authentication and OTP flow (`tests/auth.test.ts`)
- Multi-store discovery and geofencing (`tests/store.test.ts`)
- Catalog categories and products (`tests/catalog.test.ts`, `tests/product.test.ts`)
- Store-specific inventory and manager permissions (`tests/inventory.test.ts`)
- Customer cart and order placement (`tests/order.test.ts`, `tests/customer.test.ts`)
- Admin orders, pickup verification, and status workflows (`tests/admin_order.test.ts`)
- Admin payments and online-payment integrity (`tests/admin_payment.test.ts`)
- Fare rules, COD validation, and system settings (`tests/admin_fares_cod_settings.test.ts`)
- Store management and manager assignment (`tests/admin_store.test.ts`, `tests/manager.test.ts`)
- Marketing banners and audit logs (`tests/admin_audit_banner.test.ts`)
- Device token registration and notifications (`tests/notification.test.ts`)

---

## Development Workflow

The repository follows a structured Git branching model:
- `main`: Production releases and stable codebase.
- `develop`: Integration branch for tested feature branches.
- `feature/*`: Isolated feature branches (e.g., `feature/backend`, `feature/admin-panel`, `feature/customer-app`).

---

## API Integration

- **Customer App (Flutter)**: Interacts with Customer Auth, Stores, Catalog, Cart, Orders, online payment (Cashfree, planned), and FCM Token registration. See [docs/MOBILE_API_MAP.md](../docs/MOBILE_API_MAP.md) and [docs/MOBILE_ARCHITECTURE.md](../docs/MOBILE_ARCHITECTURE.md).
- **Admin Panel (React/Vite)**: Interacts with Admin Auth, Orders, Stores, Inventory Management, Managers, Settings, and Audit Logs via [apps/admin/src/services/api.ts](../apps/admin/src/services/api.ts).

---

## Security Considerations

- **Secret Management**: Keep database URLs, JWT secrets, and payment API keys strictly in `.env`. Never commit `.env` to Git.
- **Authentication**: All sensitive customer and administrative endpoints require valid JWT Bearer tokens.
- **Password Security**: Passwords are encrypted using `bcryptjs` with salt rounds before storage.
- **Data Isolation**: Store manager access is strictly validated against their assigned store ID.
- **CORS Protection**: CORS middleware is enabled to manage origin policies.

---

## Logging & Monitoring

- Server startup, incoming requests, and route handling events are logged to the console.
- Unhandled errors are captured by the global Express error middleware (`src/app.ts`) and formatted into consistent JSON error responses.

---

## Deployment

> Containerization (Dockerfile/docker-compose) and CI/CD deployment pipelines are not currently included in this repository.

To deploy in a Node.js hosting environment:
1. Build TypeScript files: `npm run build`
2. Apply migrations: `npx prisma migrate deploy` (never `db push`)
3. Start the production server: `npm start`

---

## Troubleshooting

- **PostgreSQL Connection Error**: Ensure PostgreSQL is running, port `5432` is accessible, and the `DATABASE_URL` in `.env` has valid credentials.
- **Prisma Client Out of Sync**: Run `npx prisma generate` after any schema modification.
- **Port 5001 Already in Use**: Specify an alternate port in `.env` via `PORT=5002` or terminate the conflicting process.
- **Invalid Token / 401 Unauthorized**: Ensure `JWT_SECRET` and `JWT_REFRESH_SECRET` are set in `.env` and match the signing secret.

---

## Current Status

### Implemented
- Complete RESTful API for Customers, Store Managers, and Super Admins.
- PostgreSQL schema and Prisma models covering multi-store inventory and order lifecycle.
- OTP authentication, JWT role-based access control, and store isolation.
- COD charge rules (online payment verification arrives with Cashfree).
- Comprehensive automated test suite passing across all modules.

### Planned / Future
- Live order tracking with driver app / delivery partner assignments.
- SMS gateway integration (e.g. Twilio / Fast2SMS) for real SMS delivery in production.
- Cloud image uploads (e.g., Cloudinary / AWS S3) for catalog images and banners.

---

## Related Documentation

- [docs/MOBILE_API_MAP.md](../docs/MOBILE_API_MAP.md) — Endpoint mapping for Flutter Mobile App
- [docs/MOBILE_ARCHITECTURE.md](../docs/MOBILE_ARCHITECTURE.md) — Customer App Architecture and State Management
- [docs/MOBILE_INTEGRATION_REPORT.md](../docs/MOBILE_INTEGRATION_REPORT.md) — API integration report
- [docs/implementation_plan.md](../docs/implementation_plan.md) — Monorepo implementation design and plan

---

## License

This project is licensed under the **ISC License** as specified in `package.json`.
