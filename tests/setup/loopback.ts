import http from 'http';
import { once } from 'events';
import { Test } from 'supertest';
import app from '../../src/app';

/**
 * Supertest normally starts the app with listen(0) on all addresses and then calls
 * 127.0.0.1:<port>. On macOS another local program (a running Flutter app, the Dart
 * debugger …) can hold that same port on 127.0.0.1 only, and the request then reaches it
 * (random 405 / ECONNRESET failures). Instead, each test file gets one server bound to
 * 127.0.0.1 (the OS picks a port that is free there) and request(app) is pointed at it.
 */
let server: http.Server | null = null;

beforeAll(async () => {
  server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

type ServerAddress = (this: Test, target: http.Server, path: string) => string;
const proto = Test.prototype as unknown as { serverAddress: ServerAddress };
const originalServerAddress = proto.serverAddress;
proto.serverAddress = function serverAddress(this: Test, target: http.Server, path: string) {
  const handler = target.listeners('request')[0];
  const address = server?.address();
  if (!target.address() && handler === app && address && typeof address === 'object') {
    return `http://127.0.0.1:${address.port}${path}`;
  }
  return originalServerAddress.call(this, target, path);
};
