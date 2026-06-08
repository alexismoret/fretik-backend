/**
 * Shared auth constants. Single source of truth for values that must agree
 * across the Better Auth plugin config (`lib/auth.ts`) and the transactional
 * email copy (`emails/generators.ts`). Change them here only.
 */

/** Lifetime of email one-time-passwords (verification / reset / change). */
export const OTP_EXPIRY_SECONDS = 600;
export const OTP_EXPIRY_MINUTES = OTP_EXPIRY_SECONDS / 60;
