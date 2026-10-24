/**
 * Creates the first Super Admin on a live (or any) database. Never deletes or changes other data.
 *
 *   SUPER_ADMIN_EMAIL=owner@example.com SUPER_ADMIN_NAME="Owner" npm run admin:create
 *
 * The password is asked for without showing it on screen (or read from SUPER_ADMIN_PASSWORD
 * when there is no terminal, e.g. a one-off deploy job). Add --allow-additional to create a
 * second Super Admin. Uses DATABASE_URL like the server.
 */
import readline from 'readline';
import { createSuperAdmin } from '../services/superAdminService';
import { disconnectDb } from '../config/db';
import { AppError } from '../utils/errors';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (s: string) => void };
    let muted = false;
    output._writeToOutput = (s: string) => {
      if (!muted) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<number> {
  const email = process.env.SUPER_ADMIN_EMAIL ?? '';
  const name = process.env.SUPER_ADMIN_NAME ?? '';
  if (!email || !name) {
    console.error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_NAME. Example:\n  SUPER_ADMIN_EMAIL=owner@example.com SUPER_ADMIN_NAME="Owner" npm run admin:create');
    return 1;
  }

  let password = process.env.SUPER_ADMIN_PASSWORD ?? '';
  if (!password) {
    if (!process.stdin.isTTY) {
      console.error('No terminal to ask for the password: set SUPER_ADMIN_PASSWORD for this one run.');
      return 1;
    }
    password = await askHidden('Password (8-72 characters, a letter and a number): ');
    const again = await askHidden('Repeat password: ');
    if (password !== again) {
      console.error('Passwords do not match.');
      return 1;
    }
  }

  try {
    const admin = await createSuperAdmin({ email, name, password }, { allowAdditional: process.argv.includes('--allow-additional') });
    console.log(`Super Admin created: ${admin.email} (${admin.name}). Sign in to the admin panel with this email.`);
    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      console.error(`Not created: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

main()
  .then(async (code) => {
    await disconnectDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error('Failed to create the Super Admin:', (error as Error).message);
    await disconnectDb();
    process.exit(1);
  });
