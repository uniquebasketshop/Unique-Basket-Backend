import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging, SendResponse } from 'firebase-admin/messaging';
import dotenv from 'dotenv';
import { prisma } from '../config/db';
import { isVerboseLogging } from '../utils/logger';

dotenv.config();

let firebaseInitialized = false;

// Attempt to initialize Firebase Admin SDK using service account env variable
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    initializeApp({
      credential: cert(serviceAccount),
    });
    firebaseInitialized = true;
    console.log('[FIREBASE] Admin SDK initialized successfully.');
  } else {
    console.log('[FIREBASE-MOCK] FIREBASE_SERVICE_ACCOUNT not configured. Falling back to console simulation.');
  }
} catch (error) {
  console.error('[FIREBASE] Error initializing Admin SDK. Falling back to simulation:', error);
}

export class NotificationService {
  /**
   * Persist in-app notification and send push notification to customer devices.
   */
  static async sendToUser(
    userId: string,
    title: string,
    body: string,
    dataPayload?: Record<string, string>
  ): Promise<any> {
    let savedNotification = null;

    // 1. Always persist the in-app notification record
    try {
      savedNotification = await prisma.notification.create({
        data: {
          userId,
          title,
          body,
          type: dataPayload?.type || 'ORDER_STATUS',
          orderId: dataPayload?.orderId || null,
          orderNumber: dataPayload?.orderNumber || null,
          tag: dataPayload?.tag || dataPayload?.orderNumber || null,
          actionText: dataPayload?.actionText || null,
          promoCode: dataPayload?.promoCode || null,
          isRead: false,
        },
      });
    } catch (dbErr) {
      console.error('[NOTIFICATION-DB] Error saving in-app notification:', dbErr);
    }

    // 2. Attempt FCM push dispatch
    try {
      const tokens = await prisma.deviceToken.findMany({
        where: { userId },
      });

      if (tokens.length === 0) {
        console.log(`[FCM-MOCK] No registered tokens for user ID: ${userId}. In-app notification saved${isVerboseLogging() ? `: "${title}: ${body}"` : '.'}`);
        return savedNotification;
      }

      const tokenStrings = tokens.map((t) => t.token);

      if (firebaseInitialized) {
        const messagePayload = {
          notification: { title, body },
          data: dataPayload,
          tokens: tokenStrings,
        };

        const response = await getMessaging().sendEachForMulticast(messagePayload);
        
        // Clean up invalid or expired tokens returned by FCM
        const tokensToRemove: string[] = [];
        response.responses.forEach((resp: SendResponse, idx: number) => {
          if (!resp.success) {
            const error = resp.error;
            if (
              error?.code === 'messaging/invalid-registration-token' ||
              error?.code === 'messaging/registration-token-not-registered'
            ) {
              tokensToRemove.push(tokenStrings[idx]);
            }
          }
        });

        if (tokensToRemove.length > 0) {
          await prisma.deviceToken.deleteMany({
            where: { token: { in: tokensToRemove } },
          });
          console.log(`[FCM] Cleaned up ${tokensToRemove.length} expired device tokens.`);
        }
      } else {
        console.log(`[FCM-MOCK-DELIVERY] Sent to User: ${userId} (Tokens: ${tokenStrings.length})${isVerboseLogging() ? ` - Title: "${title}" | Body: "${body}"` : ''}`);
      }
    } catch (error) {
      console.error('[FCM] Error sending message to user:', error);
    }
  }

  /**
   * Send notification to all managers assigned to a specific store.
   */
  static async sendToStoreManagers(storeId: string, title: string, body: string, dataPayload?: Record<string, string>): Promise<void> {
    try {
      // Find all managers for this storeId
      const managers = await prisma.storeManager.findMany({
        where: { storeId },
        select: { adminUserId: true },
      });

      const managerIds = managers.map((m) => m.adminUserId);

      if (managerIds.length === 0) {
        console.log(`[FCM-MOCK] No managers assigned to store: ${storeId}`);
        return;
      }

      // Fetch manager device tokens
      const tokens = await prisma.deviceToken.findMany({
        where: { adminUserId: { in: managerIds } },
      });

      if (tokens.length === 0) {
        console.log(`[FCM-MOCK] No tokens for managers of store: ${storeId}.${isVerboseLogging() ? ` Notifying console: "${title}: ${body}"` : ''}`);
        return;
      }

      const tokenStrings = tokens.map((t) => t.token);

      if (firebaseInitialized) {
        const messagePayload = {
          notification: { title, body },
          data: dataPayload,
          tokens: tokenStrings,
        };

        const response = await getMessaging().sendEachForMulticast(messagePayload);
        
        // Prune stale tokens
        const tokensToRemove: string[] = [];
        response.responses.forEach((resp: SendResponse, idx: number) => {
          if (!resp.success) {
            const error = resp.error;
            if (
              error?.code === 'messaging/invalid-registration-token' ||
              error?.code === 'messaging/registration-token-not-registered'
            ) {
              tokensToRemove.push(tokenStrings[idx]);
            }
          }
        });

        if (tokensToRemove.length > 0) {
          await prisma.deviceToken.deleteMany({
            where: { token: { in: tokensToRemove } },
          });
        }
      } else {
        console.log(`[FCM-MOCK-DELIVERY] Sent to Store Managers of ${storeId} (Tokens: ${tokenStrings.length})${isVerboseLogging() ? ` - Title: "${title}" | Body: "${body}"` : ''}`);
      }
    } catch (error) {
      console.error('[FCM] Error sending message to store managers:', error);
    }
  }
}
