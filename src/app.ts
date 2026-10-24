import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Prisma } from '@prisma/client';
import { AppError } from './utils/errors';
import { corsOptions, securityHeaders, configureProxyTrust, BODY_LIMIT } from './config/http';
import { requestLogger } from './utils/logger';
import { prisma } from './config/db';
import authRoutes from './routes/authRoutes';
import adminRoutes from './routes/adminRoutes';
import storeRoutes from './routes/storeRoutes';
import categoryRoutes from './routes/categoryRoutes';
import productRoutes from './routes/productRoutes';
import cartRoutes from './routes/cartRoutes';
import orderRoutes from './routes/orderRoutes';
import notificationRoutes from './routes/notificationRoutes';
import paymentRoutes from './routes/paymentRoutes';
import customerRoutes from './routes/customerRoutes';
import bannerRoutes from './routes/bannerRoutes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Middlewares (P3-03: restricted CORS, security headers, proxy trust, body limits)
app.disable('x-powered-by');
configureProxyTrust(app);
app.use(securityHeaders);
app.use(requestLogger);
app.use(cors(corsOptions));
app.use(
  express.json({
    limit: BODY_LIMIT,
    // Webhook signatures are computed over the exact bytes received
    verify: (req, _res, buf) => {
      if ((req as Request).originalUrl?.startsWith('/api/v1/payments/webhook')) {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      }
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/customer', customerRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/stores', storeRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/banners', bannerRoutes);
app.use('/api/v1/cart', cartRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/payments', paymentRoutes);

// Health Check Route (P3-04: reports database connectivity; 503 when the DB is unreachable)
app.get('/health', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      success: true,
      message: 'UNIQUE BASKET API Server is running smoothly.',
      database: 'up',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      success: false,
      message: 'Database is unavailable.',
      database: 'down',
      timestamp: new Date().toISOString(),
    });
  }
});

// 404 Route Handler
app.use((req: Request, res: Response, next: NextFunction) => {
  res.status(404).json({
    success: false,
    message: `Resource not found: ${req.method} ${req.originalUrl}`,
  });
});

/**
 * Maps known client errors (AppError, malformed JSON, Prisma request errors) to 4xx responses.
 * Returns null for unexpected errors.
 */
function mapClientError(err: any): { status: number; errorCode: string; message: string } | null {
  if (err instanceof AppError) {
    return { status: err.status, errorCode: err.errorCode, message: err.message };
  }

  if (err?.type === 'entity.too.large') {
    return { status: 413, errorCode: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' };
  }

  // Malformed JSON body (express.json / body-parser)
  if (err?.type === 'entity.parse.failed') {
    return { status: 400, errorCode: 'INVALID_JSON', message: 'Request body contains invalid JSON.' };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const pgCode = (err.meta as any)?.driverAdapterError?.cause?.originalCode;

    // Invalid UUID or other malformed value (Postgres 22P02)
    if (err.code === 'P2007' || pgCode === '22P02') {
      return { status: 400, errorCode: 'INVALID_ID', message: 'One or more identifiers are invalid.' };
    }
    // A value longer than its column (Postgres 22001): a validation gap, not a server error
    if (err.code === 'P2000' || pgCode === '22001') {
      return { status: 400, errorCode: 'VALUE_TOO_LONG', message: 'One or more values are too long.' };
    }
    if (err.code === 'P2025') {
      return { status: 404, errorCode: 'RESOURCE_NOT_FOUND', message: 'The requested resource was not found.' };
    }
    if (err.code === 'P2002') {
      return { status: 409, errorCode: 'DUPLICATE_RESOURCE', message: 'A resource with the same unique value already exists.' };
    }
    if (err.code === 'P2003') {
      return { status: 400, errorCode: 'INVALID_REFERENCE', message: 'A referenced resource does not exist.' };
    }
  }

  // Invalid argument types/enums passed to Prisma (e.g. unknown unit or status value)
  if (err instanceof Prisma.PrismaClientValidationError) {
    return { status: 400, errorCode: 'VALIDATION_ERROR', message: 'Request contains invalid values.' };
  }

  return null;
}

// Global Error Handling Middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const clientError = mapClientError(err);
  if (clientError) {
    res.status(clientError.status).json({
      success: false,
      message: clientError.message,
      errorCode: clientError.errorCode,
    });
    return;
  }

  console.error('Unhandled Server Error:', err);

  const statusCode = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error occurred.'
    : err.message || 'An unexpected error occurred.';

  res.status(statusCode).json({
    success: false,
    message,
    errorCode: statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : err.code || 'REQUEST_ERROR',
  });
});

export default app;
