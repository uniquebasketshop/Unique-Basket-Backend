/**
 * A customer who deleted their account keeps their user row (orders still point to it) but the
 * phone is replaced by this placeholder, so the number is free to sign up again and the row is
 * recognisable as deleted. Real phones are always "+91XXXXXXXXXX" (D-008), so they never match.
 */
export const DELETED_PHONE_PREFIX = 'DEL';

/** Placeholder phone for a deleted account: "DEL" + 12 hex characters of the user id (fits VarChar(15)). */
export function deletedPhoneFor(userId: string): string {
  return `${DELETED_PHONE_PREFIX}${userId.replace(/-/g, '').slice(0, 12)}`;
}

export function isDeletedAccount(user: { phone: string }): boolean {
  return user.phone.startsWith(DELETED_PHONE_PREFIX);
}
