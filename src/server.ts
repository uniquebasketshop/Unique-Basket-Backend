import app from './app';
import { Server } from 'http';
import { connectDb, disconnectDb } from './config/db';
import { validateEnv } from './config/validateEnv';
import { allowedOrigins } from './config/http';
import { startPaymentJobs } from './jobs/paymentJobs';
import { getCashfreeConfig } from './services/payments/cashfreeClient';

const PORT = process.env.PORT || 5001;

async function bootstrap() {
  // Refuse to start with missing or insecure secrets
  try {
    validateEnv();
  } catch (error: any) {
    console.error(`[server]: ${error.message}`);
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && allowedOrigins().length === 0) {
    console.warn('[server]: CORS_ORIGINS is not set; browser clients (admin panel) will be blocked by CORS.');
  }

  const cashfree = getCashfreeConfig();
  if (!cashfree) {
    console.warn('[server]: Cashfree is not configured (CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET); online payment is unavailable, cash only.');
  } else {
    console.log(`[server]: Cashfree ${cashfree.environment} mode${cashfree.notifyUrl ? '' : ' (no PUBLIC_API_BASE_URL: webhooks off, status checks only)'}.`);
  }

  // Establish connection to PostgreSQL
  try {
    await connectDb();
  } catch {
    process.exit(1);
  }

  // Listen on configured port
  const server = app.listen(PORT, () => {
    console.log(`[server]: UNIQUE BASKET API is running at http://localhost:${PORT}`);
  });

  const stopPaymentJobs = startPaymentJobs();
  registerGracefulShutdown(server, stopPaymentJobs);
}

/** Grace period for in-flight requests before forcing exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * P3-05: on SIGTERM/SIGINT stop accepting connections, let in-flight requests finish,
 * close the database pool, then exit. Forces exit after SHUTDOWN_TIMEOUT_MS.
 */
function registerGracefulShutdown(server: Server, stopJobs: () => void): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server]: ${signal} received, shutting down gracefully...`);
    stopJobs();

    const forceExit = setTimeout(() => {
      console.error('[server]: Graceful shutdown timed out; forcing exit.');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(async (closeError) => {
      try {
        await disconnectDb();
      } catch (dbError) {
        console.error('[server]: Error while closing database connections:', dbError);
      }
      console.log('[server]: Shutdown complete.');
      process.exit(closeError ? 1 : 0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap();
