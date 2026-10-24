import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

// P0-07: This seed DELETES all existing data and creates admin accounts.
// It may only run when NODE_ENV is explicitly 'development' or 'test'.
const SEED_ALLOWED_ENVS = ['development', 'test'];
if (!SEED_ALLOWED_ENVS.includes(process.env.NODE_ENV ?? '')) {
  console.error(
    `[seed] Refusing to run: NODE_ENV is "${process.env.NODE_ENV ?? '(unset)'}". ` +
      'This seed wipes all data and is allowed only when NODE_ENV is "development" or "test".'
  );
  process.exit(1);
}

// Dev/test admin passwords. Override via env to avoid sharing well-known credentials.
const SEED_SUPER_ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD || 'SuperSecretPassword123';
const SEED_MANAGER_PASSWORD = process.env.SEED_MANAGER_PASSWORD || 'ManagerPassword123';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

// Second guard: NODE_ENV can come from a stray .env, so also check the target database.
// Only a database on this machine is seeded, unless SEED_CONFIRM_DATABASE names the database
// (e.g. a Docker or shared dev database). Production databases are never on localhost.
const LOCAL_DB_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
let dbHost = '';
let dbName = '';
try {
  const dbUrl = new URL(connectionString);
  dbHost = dbUrl.hostname;
  dbName = decodeURIComponent(dbUrl.pathname.replace(/^\//, ''));
} catch {
  // Unparseable URL: refused below
}
if (!dbName || (!LOCAL_DB_HOSTS.includes(dbHost) && process.env.SEED_CONFIRM_DATABASE !== dbName)) {
  console.error(
    `[seed] Refusing to run: database "${dbName || '(unknown)'}" on host "${dbHost || '(unknown)'}" is not local. ` +
      'This seed wipes all data. To seed a non-local dev/test database, set SEED_CONFIRM_DATABASE to its name.'
  );
  process.exit(1);
}

// UTC sessions, like the app (src/config/db.ts): timestamps are stored as given
const pool = new Pool({ connectionString, options: '-c TimeZone=UTC' });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding database...');

  // 1. Clean existing records (Reverse order of dependencies)
  await prisma.auditLog.deleteMany({});
  await prisma.deviceToken.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.storeInventory.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.storeManager.deleteMany({});
  await prisma.adminUser.deleteMany({});
  await prisma.store.deleteMany({});
  await prisma.userAddress.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.deliverySettings.deleteMany({});
  await prisma.banner.deleteMany({});
  await prisma.supportedPincode.deleteMany({});

  console.log('Cleared existing records.');

  // 2. Create System Delivery Settings
  const deliverySettings = await prisma.deliverySettings.create({
    data: {
      deliveryEnabled: true,
      deliveryFee: 30.00,
      freeDeliveryThreshold: 200.00,
      minimumOrderAmount: 199.00,
      codEnabled: true,
      codCharge: 20.00,
      minimumCodOrderAmount: 100.00,
      maximumCodOrderAmount: 5000.00,
      pickupCodEnabled: true,
    },
  });
  console.log('Seeded delivery settings:', deliverySettings);

  // 3. Create Admin Users
  const superAdminPassword = await bcrypt.hash(SEED_SUPER_ADMIN_PASSWORD, 10);
  const managerPassword = await bcrypt.hash(SEED_MANAGER_PASSWORD, 10);

  const superAdmin = await prisma.adminUser.create({
    data: {
      email: 'superadmin@uniquebasket.com',
      passwordHash: superAdminPassword,
      name: 'Super Admin',
      role: 'SUPER_ADMIN',
    },
  });

  const manager1 = await prisma.adminUser.create({
    data: {
      email: 'manager1@uniquebasket.com',
      passwordHash: managerPassword,
      name: 'Central Store Manager',
      role: 'STORE_MANAGER',
    },
  });

  const manager2 = await prisma.adminUser.create({
    data: {
      email: 'manager2@uniquebasket.com',
      passwordHash: managerPassword,
      name: 'East Store Manager',
      role: 'STORE_MANAGER',
    },
  });

  console.log('Seeded admin users.');

  // 4. Create Stores (Store One = ACTIVE, others = INACTIVE)
  const centralStore = await prisma.store.create({
    data: {
      storeId: 'STORE-001',
      name: 'Store One',
      address: 'Nana Mava Main Rd, Opp. Haridwar Heights, Satyam Park, Nana Mava',
      city: 'Rajkot',
      state: 'Gujarat',
      pincode: '360005',
      latitude: 22.308155,
      longitude: 70.800705,
      deliveryRadiusKm: 15.00, // 15 km covers all Rajkot deliverable pincodes (360001-360007)
      phone: '+919876543210',
      email: 'storeone@uniquebasket.com',
      openingTime: '07:00',
      closingTime: '22:00',
      isActive: true,
    },
  });

  const eastStore = await prisma.store.create({
    data: {
      storeId: 'STORE-002',
      name: 'Unique Basket - East Store',
      address: '200 Indiranagar Double Road, East Bangalore',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560038',
      latitude: 12.971891,
      longitude: 77.641151,
      deliveryRadiusKm: 8.00, // 8 km
      phone: '+919876543211',
      email: 'east@uniquebasket.com',
      openingTime: '08:00',
      closingTime: '22:00',
      isActive: false, // Inactive
    },
  });

  const northStore = await prisma.store.create({
    data: {
      storeId: 'STORE-003',
      name: 'Unique Basket - North Store',
      address: '300 Hebbal Flyover, North Bangalore',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560024',
      latitude: 13.035356,
      longitude: 77.598789,
      deliveryRadiusKm: 12.00, // 12 km
      phone: '+919876543212',
      email: 'north@uniquebasket.com',
      openingTime: '08:00',
      closingTime: '22:00',
      isActive: false, // Inactive
    },
  });

  console.log('Seeded stores (Store One = ACTIVE, others = INACTIVE).');

  // 5. Assign Managers to Stores
  await prisma.storeManager.createMany({
    data: [
      { adminUserId: manager1.id, storeId: centralStore.id },
      { adminUserId: manager2.id, storeId: eastStore.id },
    ],
  });
  console.log('Assigned store managers.');

  // 6. Create Categories
  const fruits = await prisma.category.create({
    data: {
      name: 'Fruits',
      imageUrl: 'https://images.unsplash.com/photo-1619546813926-a78fa6372cd2?auto=format&fit=crop&q=80&w=400',
      displayOrder: 1,
    },
  });

  const vegetables = await prisma.category.create({
    data: {
      name: 'Vegetables',
      imageUrl: 'https://images.unsplash.com/photo-1597362925123-77861d3fbac7?auto=format&fit=crop&q=80&w=400',
      displayOrder: 2,
    },
  });

  const leafyVegetables = await prisma.category.create({
    data: {
      name: 'Leafy Vegetables',
      imageUrl: 'https://images.unsplash.com/photo-1576045057995-568f588f82fb?auto=format&fit=crop&q=80&w=400',
      displayOrder: 3,
    },
  });

  console.log('Seeded categories.');

  // 7. Create Products
  const productsData = [
    // Fruits
    { name: 'Apple (Shimla)', categoryId: fruits.id, price: 180.00, mrp: 220.00, unit: 'KG' as const, description: 'Fresh Shimla red apples directly from orchards.' },
    { name: 'Banana (Robusta)', categoryId: fruits.id, price: 60.00, mrp: 80.00, unit: 'DOZEN' as const, description: 'High quality sweet robusta bananas.' },
    
    // Vegetables
    { name: 'Potato (Jyoti)', categoryId: vegetables.id, price: 30.00, mrp: 40.00, unit: 'KG' as const, description: 'Fresh local farm potatoes.' },
    { name: 'Tomato (Local)', categoryId: vegetables.id, price: 40.00, mrp: 60.00, unit: 'KG' as const, description: 'Ripe local red tomatoes.' },
    
    // Leafy Vegetables
    { name: 'Spinach (Palak)', categoryId: leafyVegetables.id, price: 25.00, mrp: 35.00, unit: 'PACK' as const, description: 'Fresh, cleaned spinach pack.' },
  ];

  const products: any[] = [];
  for (const item of productsData) {
    const product = await prisma.product.create({
      data: item,
    });
    products.push(product);
  }
  console.log('Seeded products.');

  // 8. Create Store Inventories
  // Apples
  await prisma.storeInventory.createMany({
    data: [
      { storeId: centralStore.id, productId: products[0].id, stockQuantity: 50.000, lowStockThreshold: 10.000 },
      { storeId: eastStore.id, productId: products[0].id, stockQuantity: 30.000, lowStockThreshold: 5.000 },
      { storeId: northStore.id, productId: products[0].id, stockQuantity: 10.000, lowStockThreshold: 3.000 },
    ],
  });

  // Bananas
  await prisma.storeInventory.createMany({
    data: [
      { storeId: centralStore.id, productId: products[1].id, stockQuantity: 20.000, lowStockThreshold: 5.000 },
      { storeId: eastStore.id, productId: products[1].id, stockQuantity: 15.000, lowStockThreshold: 3.000 },
      { storeId: northStore.id, productId: products[1].id, stockQuantity: 5.000, lowStockThreshold: 2.000 },
    ],
  });

  // Potatoes
  await prisma.storeInventory.createMany({
    data: [
      { storeId: centralStore.id, productId: products[2].id, stockQuantity: 100.000, lowStockThreshold: 20.000 },
      { storeId: eastStore.id, productId: products[2].id, stockQuantity: 80.000, lowStockThreshold: 15.000 },
      { storeId: northStore.id, productId: products[2].id, stockQuantity: 20.000, lowStockThreshold: 5.000 },
    ],
  });

  // Tomatoes
  await prisma.storeInventory.createMany({
    data: [
      { storeId: centralStore.id, productId: products[3].id, stockQuantity: 80.000, lowStockThreshold: 15.000 },
      { storeId: eastStore.id, productId: products[3].id, stockQuantity: 50.000, lowStockThreshold: 10.000 },
      { storeId: northStore.id, productId: products[3].id, stockQuantity: 15.000, lowStockThreshold: 4.000 },
    ],
  });

  // Spinach
  await prisma.storeInventory.createMany({
    data: [
      { storeId: centralStore.id, productId: products[4].id, stockQuantity: 30.000, lowStockThreshold: 5.000 },
      { storeId: eastStore.id, productId: products[4].id, stockQuantity: 20.000, lowStockThreshold: 4.000 },
      { storeId: northStore.id, productId: products[4].id, stockQuantity: 8.000, lowStockThreshold: 2.000 },
    ],
  });

  console.log('Seeded store inventories.');

  // 9. Create Marketing Banners
  await prisma.banner.createMany({
    data: [
      {
        title: 'Fresh Produce\nSpecial Offer',
        imageUrl: 'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&q=80&w=800',
        displayOrder: 1,
        isActive: true,
      },
      {
        title: 'Organic Veggies\nFlat 20% OFF',
        imageUrl: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&q=80&w=800',
        displayOrder: 2,
        isActive: true,
      },
      {
        title: 'Fresh Harvest\nDaily Discounts',
        imageUrl: 'https://images.unsplash.com/photo-1576045057995-568f588f82fb?auto=format&fit=crop&q=80&w=800',
        displayOrder: 3,
        isActive: true,
      },
    ],
  });
  console.log('Seeded marketing banners.');

  // 10. Create Supported Pincodes (Initial Rajkot Deliverable Areas)
  const initialPincodes = [
    { pincode: '360001', city: 'Rajkot', state: 'Gujarat', isActive: true },
    { pincode: '360002', city: 'Rajkot', state: 'Gujarat', isActive: true },
    { pincode: '360003', city: 'Rajkot', state: 'Gujarat', isActive: true },
    { pincode: '360004', city: 'Rajkot', state: 'Gujarat', isActive: true },
    { pincode: '360005', city: 'Rajkot', state: 'Gujarat', isActive: true },
    { pincode: '360006', city: 'Rajkot', state: 'Gujarat', isActive: true },
    { pincode: '360007', city: 'Rajkot', state: 'Gujarat', isActive: true },
  ];

  await prisma.supportedPincode.createMany({
    data: initialPincodes,
  });
  console.log('Seeded supported pincodes (Rajkot 360001-360007).');

  // 11. Seed audit log
  await prisma.auditLog.create({
    data: {
      adminUserId: superAdmin.id,
      action: 'SYSTEM_INITIAL_SEED',
      details: 'Successfully executed system relational initial seeding including supported pincodes.',
    },
  });

  console.log('Seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
