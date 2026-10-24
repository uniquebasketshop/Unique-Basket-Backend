/**
 * Built-in profile characters (D-024). Must match the app's list
 * (apps/customer_app/.../profile_avatar.dart) and the admin panel's (src/utils/avatars.ts).
 * Customers choose one of these ids or none (initials); photos are never accepted.
 */
export const AVATAR_IDS = [
  'apple', 'mango', 'banana', 'grapes', 'watermelon', 'strawberry',
  'orange', 'pineapple', 'carrot', 'broccoli', 'corn', 'tomato',
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];
