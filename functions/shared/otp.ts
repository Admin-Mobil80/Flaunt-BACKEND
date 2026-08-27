import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** Six digits, uniformly distributed. randomInt is CSPRNG-backed; Math.random is not. */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * The code is never stored in the clear. Salting with the email means two users
 * holding the same six digits at the same moment produce different hashes, so a
 * stolen row cannot be replayed against another account.
 */
export function hashOtp(code: string, email: string): string {
  return createHash('sha256').update(`${email.toLowerCase()}:${code}`).digest('hex');
}

/**
 * Constant-time compare. A plain `===` on hex strings leaks, through timing, how
 * many leading characters matched — enough to reconstruct a hash byte by byte
 * given sufficient attempts. The attempt counter makes that impractical here
 * anyway, but the comparison costs nothing to do correctly.
 */
export function otpMatches(submittedHash: string, storedHash: string): boolean {
  const a = Buffer.from(submittedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
