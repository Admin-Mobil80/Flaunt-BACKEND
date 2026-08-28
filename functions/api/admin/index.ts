import type { AppSyncResolverEvent } from 'aws-lambda';
import { QueryCommand, GetCommand, ScanCommand, TransactWriteCommand, PutCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import * as k from '../../shared/keys';
import {
  ALLOWED_BUNDLE_SIZES, coerceBundleSize, isAllowedBundleSize,
  PAYMENT_MODES, coercePaymentMode, isPaymentMode, RAZORPAY_SECRET_BY_MODE,
  coerceSignupGrant, isSignupGrant, MIN_SIGNUP_TOKENS, MAX_SIGNUP_TOKENS,
} from '../../shared/pricing';

const ROOT_ADMIN_EMAIL = (process.env.ROOT_ADMIN_EMAIL ?? '').toLowerCase();
const BMS_POOL_ID = process.env.BMS_USER_POOL_ID ?? '';

/**
 * Being authenticated is not being an admin.
 *
 * One AppSync endpoint accepts tokens from two Cognito pools, so a perfectly
 * valid member token would otherwise reach these fields. Two checks, both
 * against verified claims rather than arguments: the token must come from the
 * BMS pool, and the identity must be the root admin (PRD §4.1).
 */
function assertAdmin(event: any): string {
  const claims = event?.identity?.claims ?? {};
  const iss = String(claims.iss ?? '');
  const email = String(claims.email ?? '').toLowerCase();
  if (BMS_POOL_ID && !iss.endsWith(BMS_POOL_ID)) throw new Error('Unauthorized');
  if (!email || email !== ROOT_ADMIN_EMAIL) throw new Error('Unauthorized');
  return email;
}

/**
 * Reads every profile once, projecting only the columns the admin views need.
 *
 * A Scan returns at most 1MB per call and then stops WITHOUT erroring, so this
 * pages explicitly; the unpaginated version would quietly report on a subset and
 * look perfectly healthy doing it.
 */
async function allProfiles(): Promise<any[]> {
  const items: any[] = [];
  let ExclusiveStartKey: any = undefined;
  do {
    const r: any = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :t',
      ExpressionAttributeValues: { ':t': 'USER' },
      ProjectionExpression: 'PK, #n, primaryEmail, country, tokenBalance, createdAt',
      ExpressionAttributeNames: { '#n': 'name' },
      ExclusiveStartKey,
    }));
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * The user ledger, newest first.
 *
 * This used to read each profile individually and then run a COUNT query per
 * user — two round trips each. adminStats asked for five hundred of them, which
 * is a thousand reads in one invocation: fine at ten accounts, a fifteen-second
 * timeout at a thousand. Now it is one projected scan for the whole list, and
 * connection counts are fetched only for the page actually being shown.
 */
async function adminUsers(limit = 50, offset = 0) {
  const all = await allProfiles();
  all.sort((a: any, b: any) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const page = all.slice(offset, offset + limit);

  const counts = await Promise.all(page.map((u: any) =>
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': u.PK, ':sk': k.PREFIX.CONNECTION },
      Select: 'COUNT',
    }))));

  return page.map((u: any, i: number) => ({
    userId: String(u.PK).replace('USER#', ''),
    name: u.name ?? 'Unknown',
    email: u.primaryEmail ?? '',
    country: u.country ?? '',
    tokenBalance: u.tokenBalance ?? 0,
    connectionCount: counts[i].Count ?? 0,
    createdAt: u.createdAt ?? '',
  }));
}

/** Debits. Every one of these moves a token out of a member's balance. */
const SPEND_REASONS = new Set<string>([k.TXN_REASON.INVITE_SENT, k.TXN_REASON.INTRO_REQUESTED]);

/** Credits that hand a spent token back — the invite died without connecting anyone. */
const REFUND_REASONS = new Set<string>([
  k.TXN_REASON.REFUND_REJECTED,
  k.TXN_REASON.REFUND_EXPIRED,
  k.TXN_REASON.REFUND_CANCELLED,
  k.TXN_REASON.REFUND_GATEKEEPER_DENIED,
]);

/**
 * Every figure on the ledger screen, from one pass over the table.
 *
 * Consumed tokens are counted from the transaction ledger rather than the
 * STATS# counters, which are the cheaper source but not a trustworthy one: they
 * are incremented per event and never rewound, so the purges this table has
 * been through during development left them claiming seven refunds where the
 * ledger holds one. The ledger is what a member's balance reconciles against,
 * so it is what the console reports.
 *
 * A Scan applies its filter AFTER reading, so pulling the ledger rows in
 * alongside the profiles costs no extra table traversal — this is the same
 * single pass, returning more of what it already had to read.
 */
async function adminStats() {
  let users = 0, india = 0, outstanding = 0, spent = 0, refunded = 0;
  let ExclusiveStartKey: any = undefined;
  do {
    const r: any = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType IN (:u, :t)',
      ProjectionExpression: 'entityType, country, tokenBalance, #r, #d',
      ExpressionAttributeNames: { '#r': 'reason', '#d': 'delta' },
      ExpressionAttributeValues: { ':u': 'USER', ':t': 'TXN' },
      ExclusiveStartKey,
    }));
    for (const it of (r.Items ?? []) as any[]) {
      if (it.entityType === 'USER') {
        users++;
        if (it.country === 'IN') india++;
        outstanding += Number(it.tokenBalance ?? 0);
      } else {
        const reason = String(it.reason ?? '');
        // Read the magnitude off the row rather than assuming one token, so a
        // future multi-token action is counted at what it actually cost.
        if (SPEND_REASONS.has(reason)) spent += Math.abs(Number(it.delta ?? 0));
        else if (REFUND_REASONS.has(reason)) refunded += Math.abs(Number(it.delta ?? 0));
      }
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return {
    totalUsers: users,
    usersIndia: india,
    usersInternational: users - india,
    tokensOutstanding: outstanding,
    // Spent and never returned: an invitation that connected two people, or one
    // still in flight. A refunded token was never consumed.
    tokensConsumed: spent - refunded,
    tokensRefunded: refunded,
  };
}

async function adminInvitations(status?: string) {
  const statuses = status && status !== 'ALL' ? [status] : Object.values(k.INVITE_STATUS);

  const found = await Promise.all(statuses.map((s) =>
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': `INVITE_STATUS#${s}` },
      ScanIndexForward: false,
      Limit: 50,
      ProjectionExpression: 'PK, SK',
    }))
  ));

  const keys = found.flatMap((r) => r.Items ?? []).map((i: any) => ({ PK: i.PK, SK: i.SK }));
  if (keys.length === 0) return [];

  // BatchGetItem takes at most 100 keys per request.
  const chunks: any[][] = [];
  for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
  const pages = await Promise.all(chunks.map((c) =>
    ddb.send(new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: c } } }))
  ));
  const items = pages.flatMap((p) => p.Responses?.[TABLE_NAME] ?? []);

  const now = Math.floor(Date.now() / 1000);
  return items
    .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((it: any) => {
      const live = it.status === k.INVITE_STATUS.PENDING;
      const refunded = (k.TERMINAL_REFUNDS_TOKEN as readonly string[]).includes(it.status);
      return {
        // Fall back to the key when an archive row predates the attribute.
        inviteId: it.inviteId ?? String(it.PK).replace('INVITE#', ''),
        senderName: null,
        senderDesignation: null,
        recipientEmail: it.recipientEmail,
        status: it.status,
        type: it.type ?? 'DIRECT',
        createdAt: it.createdAt,
        expiresAt: it.expiresAt ?? null,
        daysLeft: live && it.expiresAt
          ? Math.max(0, Math.ceil((Number(it.expiresAt) - now) / 86400)) : null,
        tokenOutcome: refunded ? 'refunded' : (live ? 'held' : 'spent'),
      };
    });
}

/**
 * Manual balance override (§4.2). Atomic and audited: the same ADD used
 * everywhere else, guarded so a decrement cannot push anyone negative, and
 * written to the user's ledger with the admin as the actor so the adjustment
 * is never anonymous.
 */
async function adminAdjustTokens(admin: string, userId: string, delta: number, reason?: string) {
  if (!Number.isInteger(delta) || delta === 0) throw new Error('Adjustment must be a non-zero whole number.');
  const now = new Date().toISOString();

  const condition = delta < 0
    ? 'attribute_exists(PK) AND tokenBalance >= :min'
    : 'attribute_exists(PK)';
  const values: any = { ':d': delta };
  if (delta < 0) values[':min'] = Math.abs(delta);

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: k.user(userId),
            UpdateExpression: 'ADD tokenBalance :d',
            ConditionExpression: condition,
            ExpressionAttributeValues: values,
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.transaction(userId, now),
              entityType: 'TXN',
              delta,
              reason: k.TXN_REASON.ADMIN_OVERRIDE,
              note: reason ?? null,
              actorId: admin,
              createdAt: now,
            },
          },
        },
      ],
    }));
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') {
      throw new Error('That would take the balance below zero.');
    }
    throw err;
  }

  const [u] = await adminUsersFor(userId);
  return u;
}

async function adminUsersFor(userId: string) {
  const { Item: p } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(userId) }));
  if (!p) throw new Error('User not found');
  const conns = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': k.PREFIX.CONNECTION },
    Select: 'COUNT',
  }));
  return [{
    userId,
    name: p.name,
    email: p.primaryEmail,
    country: p.country,
    tokenBalance: p.tokenBalance ?? 0,
    connectionCount: conns.Count ?? 0,
    createdAt: p.createdAt,
  }];
}

async function adminPricingConfig() {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.pricingConfig() }));
  return {
    tokensPerBundle: coerceBundleSize(Item?.tokensPerBundle),
    allowedSizes: [...ALLOWED_BUNDLE_SIZES],
    signupTokens: coerceSignupGrant(Item?.signupTokens),
    signupRange: [MIN_SIGNUP_TOKENS, MAX_SIGNUP_TOKENS],
    updatedAt: Item?.updatedAt ?? null,
    updatedBy: Item?.updatedBy ?? null,
  };
}

/**
 * Changes how many tokens a bundle buys. The charged amount is untouched, so
 * this is the lever for the effective price of a connection.
 *
 * The allowed set is enforced here rather than trusted from the admin UI: a
 * free-text field plus a typo is how ₹472 comes to buy 2500 tokens.
 */
async function adminSetTokensPerBundle(admin: string, tokens: number) {
  if (!isAllowedBundleSize(tokens)) {
    throw new Error(`Tokens per bundle must be one of ${ALLOWED_BUNDLE_SIZES.join(', ')}.`);
  }
  const now = new Date().toISOString();
  const { Item: prev } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.pricingConfig() }));
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...k.pricingConfig(), entityType: 'CONFIG',
      tokensPerBundle: tokens,
      // Both settings live in one item, so a Put must carry the other or
      // changing one would silently reset the other to its default.
      signupTokens: coerceSignupGrant(prev?.signupTokens),
      updatedAt: now, updatedBy: admin,
    },
  }));
  // Pricing changes are audited like balance changes are — who, what, when.
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...k.transaction('CONFIG', now),
      entityType: 'TXN',
      delta: 0,
      reason: k.TXN_REASON.PRICING_CHANGED,
      note: `tokensPerBundle set to ${tokens}`,
      actorId: admin,
      createdAt: now,
    },
  }));
  return adminPricingConfig();
}

async function adminPaymentConfig() {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.paymentConfig() }));
  const mode = coercePaymentMode(Item?.mode);
  return {
    mode,
    modes: [...PAYMENT_MODES],
    secretName: RAZORPAY_SECRET_BY_MODE[mode],
    live: mode === 'live',
    updatedAt: Item?.updatedAt ?? null,
    updatedBy: Item?.updatedBy ?? null,
  };
}

/**
 * Switches Razorpay environments. Going live means real cards are charged, so
 * the change is audited with who made it — the same treatment a balance
 * override gets, for the same reason.
 */
async function adminSetPaymentMode(admin: string, mode: string) {
  if (!isPaymentMode(mode)) throw new Error(`Payment mode must be one of ${PAYMENT_MODES.join(', ')}.`);
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { ...k.paymentConfig(), entityType: 'CONFIG', mode, updatedAt: now, updatedBy: admin },
  }));
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...k.transaction('CONFIG', now),
      entityType: 'TXN', delta: 0, reason: k.TXN_REASON.PAYMENT_MODE_CHANGED,
      note: `payment mode set to ${mode}`, actorId: admin, createdAt: now,
    },
  }));
  return adminPaymentConfig();
}

/** Applies to accounts created from now on; existing balances are untouched. */
async function adminSetSignupTokens(admin: string, tokens: number) {
  if (!isSignupGrant(tokens)) {
    throw new Error(`Sign-up tokens must be a whole number between ${MIN_SIGNUP_TOKENS} and ${MAX_SIGNUP_TOKENS}.`);
  }
  const now = new Date().toISOString();
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.pricingConfig() }));
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...k.pricingConfig(), entityType: 'CONFIG',
      // Preserve the sibling setting — this item holds both.
      tokensPerBundle: coerceBundleSize(Item?.tokensPerBundle),
      signupTokens: tokens, updatedAt: now, updatedBy: admin,
    },
  }));
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...k.transaction('CONFIG', now), entityType: 'TXN', delta: 0,
      reason: k.TXN_REASON.PRICING_CHANGED,
      note: `signupTokens set to ${tokens}`, actorId: admin, createdAt: now,
    },
  }));
  return adminPricingConfig();
}

export const handler = async (event: AppSyncResolverEvent<any>) => {
  const admin = assertAdmin(event);
  const field = (event as any).info?.fieldName;
  const args = (event.arguments ?? {}) as any;

  switch (field) {
    case 'adminUsers': return adminUsers(args.limit ?? 50, args.offset ?? 0);
    case 'adminStats': return adminStats();
    case 'adminInvitations': return adminInvitations(args.status);
    case 'adminPricingConfig': return adminPricingConfig();
    case 'adminPaymentConfig': return adminPaymentConfig();
    case 'adminSetPaymentMode': return adminSetPaymentMode(admin, args.mode);
    case 'adminSetTokensPerBundle': return adminSetTokensPerBundle(admin, args.tokens);
    case 'adminSetSignupTokens': return adminSetSignupTokens(admin, args.tokens);
    case 'adminAdjustTokens': return adminAdjustTokens(admin, args.userId, args.delta, args.reason);
    default: throw new Error(`Unknown field ${field}`);
  }
};
