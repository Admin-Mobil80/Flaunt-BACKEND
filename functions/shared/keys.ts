/**
 * Single-table key builders. Every PK/SK/GSI value in the system is constructed
 * here — no handler should ever concatenate a key string inline.
 *
 * See docs/DATA-MODEL.md for the entity layout these encode, and for why the
 * layout deviates from the PRD's entity matrix in a few places.
 */

import { randomUUID } from 'node:crypto';

export const INVITE_STATUS = {
  PENDING: 'PENDING',
  PENDING_GATEKEEPER: 'PENDING_GATEKEEPER',
  INTRO_PENDING: 'INTRO_PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  GATEKEEPER_DENIED: 'GATEKEEPER_DENIED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type InviteStatus = (typeof INVITE_STATUS)[keyof typeof INVITE_STATUS];

/** Statuses that keep the token consumed. Every other terminal status refunds. */
export const TERMINAL_KEEPS_TOKEN: readonly InviteStatus[] = [INVITE_STATUS.ACCEPTED];

export const TERMINAL_REFUNDS_TOKEN: readonly InviteStatus[] = [
  INVITE_STATUS.REJECTED,
  INVITE_STATUS.GATEKEEPER_DENIED,
  INVITE_STATUS.EXPIRED,
  // Withdrawn by the sender before anyone acted on it. The token returns for
  // the same reason as the others: no connection was made.
  INVITE_STATUS.CANCELLED,
];

export const TXN_REASON = {
  SIGNUP_GRANT: 'SIGNUP_GRANT',
  INVITE_SENT: 'INVITE_SENT',
  INTRO_REQUESTED: 'INTRO_REQUESTED',
  REFUND_REJECTED: 'REFUND_REJECTED',
  REFUND_EXPIRED: 'REFUND_EXPIRED',
  REFUND_CANCELLED: 'REFUND_CANCELLED',
  REFUND_GATEKEEPER_DENIED: 'REFUND_GATEKEEPER_DENIED',
  PURCHASE: 'PURCHASE',
  ADMIN_OVERRIDE: 'ADMIN_OVERRIDE',
  PRICING_CHANGED: 'PRICING_CHANGED',
  PAYMENT_MODE_CHANGED: 'PAYMENT_MODE_CHANGED',
} as const;

export type TxnReason = (typeof TXN_REASON)[keyof typeof TXN_REASON];

export interface TableKey {
  PK: string;
  SK: string;
}

/**
 * Emails are case-insensitive for identity purposes. Every email that becomes
 * part of a key goes through this first, or two casings of one address become
 * two different accounts.
 */
export function normalizeEmail(email: string): string {
  return String(email).trim().toLowerCase();
}

/** Accent-folded, lowercased, whitespace-collapsed name used for prefix search. */
export function normalizeName(name: string): string {
  return String(name)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Search bucket: first character of the normalized name, or '#' if non-alphabetic. */
export function nameBucket(name: string): string {
  const first = normalizeName(name).charAt(0);
  return /[a-z]/.test(first) ? first : '#';
}

export const user = (userId: string): TableKey => ({ PK: `USER#${userId}`, SK: 'METADATA' });

export const userDirectory = (userId: string): TableKey => ({
  PK: `USER#${userId}`,
  SK: 'DIRECTORY',
});

export const emailOwnership = (email: string): TableKey => ({
  PK: `EMAIL#${normalizeEmail(email)}`,
  SK: 'UNIQUE',
});

export const connection = (ownerId: string, otherId: string): TableKey => ({
  PK: `USER#${ownerId}`,
  SK: `CONNECTION#${otherId}`,
});

export const invite = (inviteId: string): TableKey => ({
  PK: `INVITE#${inviteId}`,
  SK: 'METADATA',
});

export const inviteArchive = (inviteId: string): TableKey => ({
  PK: `INVITE#${inviteId}`,
  SK: 'ARCHIVE',
});

/** Idempotency marker — the conditional put that makes a refund exactly-once. */
export const inviteRefundMarker = (inviteId: string): TableKey => ({
  PK: `INVITE#${inviteId}`,
  SK: 'REFUND',
});

export const payment = (razorpayOrderId: string): TableKey => ({
  PK: `PAYMENT#${razorpayOrderId}`,
  SK: 'METADATA',
});

export const webhookReceipt = (razorpayEventId: string): TableKey => ({
  PK: `WEBHOOK#${razorpayEventId}`,
  SK: 'METADATA',
});

export const transaction = (
  userId: string,
  isoTimestamp: string = new Date().toISOString()
): TableKey => ({
  PK: `USER#${userId}`,
  SK: `TXN#${isoTimestamp}#${randomUUID()}`,
});

/** Platform settings BMS can change at runtime. One item, one row. */
export const pricingConfig = (): TableKey => ({ PK: 'CONFIG#PRICING', SK: 'METADATA' });

/** Which Razorpay credentials the billing integration uses. */
export const paymentConfig = (): TableKey => ({ PK: 'CONFIG#PAYMENT', SK: 'METADATA' });

export const statsGlobal = (day: string): TableKey => ({ PK: 'STATS#GLOBAL', SK: `DAY#${day}` });

export const statsCountry = (country: string, day: string): TableKey => ({
  PK: `STATS#COUNTRY#${String(country).toUpperCase()}`,
  SK: `DAY#${day}`,
});

/** GSI1 — sender outbox. */
export const gsi1Outbox = (senderId: string, createdAt: string, inviteId: string) => ({
  GSI1PK: `USER#${senderId}`,
  GSI1SK: `INVITE#${createdAt}#${inviteId}`,
});

/** GSI2 — recipient inbox, sorted so a status prefix is queryable. */
export const gsi2Inbox = (recipientEmail: string, status: InviteStatus, createdAt: string) => ({
  GSI2PK: `EMAIL#${normalizeEmail(recipientEmail)}`,
  GSI2SK: `${status}#${createdAt}`,
});

/** GSI3 — sparse multi-namespace index. One namespace per entity type. */
export const gsi3NameSearch = (name: string, userId: string) => ({
  GSI3PK: `NAME#${nameBucket(name)}`,
  GSI3SK: `${normalizeName(name)}#${userId}`,
});

export const gsi3InviteStatus = (status: InviteStatus, createdAt: string, inviteId: string) => ({
  GSI3PK: `INVITE_STATUS#${status}`,
  GSI3SK: `${createdAt}#${inviteId}`,
});

export const gsi3WebhookDay = (receivedAtIso: string, eventId: string) => ({
  GSI3PK: `WEBHOOK_DAY#${receivedAtIso.slice(0, 10)}`,
  GSI3SK: `${receivedAtIso}#${eventId}`,
});

export const gsi3UserDirectory = (country: string, createdAt: string, userId: string) => ({
  GSI3PK: `USER_DIR#${String(country).toUpperCase()}`,
  GSI3SK: `${createdAt}#${userId}`,
});

/** Sort-key prefixes for begins_with queries. */
export const PREFIX = {
  CONNECTION: 'CONNECTION#',
  TXN: 'TXN#',
  INVITE: 'INVITE#',
  DAY: 'DAY#',
} as const;

export const INVITE_TTL_DAYS = 7;

/** TTL is epoch *seconds*, not milliseconds — a ms value expires ~50,000 years out. */
export function inviteExpiryEpochSeconds(from: Date = new Date()): number {
  return Math.floor(from.getTime() / 1000) + INVITE_TTL_DAYS * 24 * 60 * 60;
}

/**
 * Authoritative expiry check. DynamoDB TTL deletes within ~48h of the timestamp
 * rather than at it, so the row still existing does not mean the invite is live —
 * every accept path must call this regardless of whether the item was found.
 */
/**
 * Masks an email for a 2nd-degree viewer (PRD §3.2): riyad@mobil80.com becomes
 * riy**@mo******.com.
 *
 * The star runs are FIXED WIDTH — always two after the local part, always six
 * after the domain — rather than one star per hidden character.
 *
 * That is deliberate, and it is why this matches the PRD's example exactly
 * where a length-preserving version does not: "mobil80" is seven characters, so
 * preserving length would print five stars after "mo", not the six the spec
 * shows. Following the spec's literal string turns out to be the better rule
 * anyway — a mask whose width tracks the hidden text tells a viewer how long
 * the address is, which is information they were not meant to have and which
 * meaningfully narrows a guess.
 *
 * Short parts keep no more than half their characters, so a two-letter local
 * part is not published whole by a rule written for longer ones.
 */
const LOCAL_STARS = 2;
const HOST_STARS = 6;

export function maskEmail(email: string): string {
  const raw = String(email ?? '').trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot <= 0) return '***';
  const host = domain.slice(0, dot);
  const tld = domain.slice(dot);
  if (!host) return '***';

  const keep = (v: string, n: number) => v.slice(0, Math.max(1, Math.min(n, Math.ceil(v.length / 2))));
  return `${keep(local, 3)}${'*'.repeat(LOCAL_STARS)}@${keep(host, 2)}${'*'.repeat(HOST_STARS)}${tld}`;
}

export function isExpired(expiresAtEpochSeconds: number, now: Date = new Date()): boolean {
  return Math.floor(now.getTime() / 1000) > Number(expiresAtEpochSeconds);
}
