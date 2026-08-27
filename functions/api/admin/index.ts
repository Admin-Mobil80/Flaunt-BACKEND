import type { AppSyncResolverEvent } from 'aws-lambda';
import { QueryCommand, GetCommand, ScanCommand, TransactWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import * as k from '../../shared/keys';
import { ALLOWED_BUNDLE_SIZES, coerceBundleSize, isAllowedBundleSize } from '../../shared/pricing';

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
 * The user directory lives in GSI3's USER_DIR# namespace, one partition per
 * country, so listing users is a handful of bounded queries rather than a table
 * scan that gets slower every day the product succeeds.
 */
async function directoryRows(limit: number) {
  const { Items = [] } = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI3',
    FilterExpression: 'begins_with(GSI3PK, :p)',
    ExpressionAttributeValues: { ':p': 'USER_DIR#' },
    Limit: Math.max(limit * 4, 100),
  }));
  return Items.slice(0, limit);
}

async function adminUsers(limit = 50) {
  const rows = await directoryRows(limit);
  const full = await Promise.all(rows.map(async (r: any) => {
    const userId = String(r.PK).replace('USER#', '');
    const [{ Item: p }, conns] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(userId) })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': k.PREFIX.CONNECTION },
        Select: 'COUNT',
      })),
    ]);
    if (!p) return null;
    return {
      userId,
      name: p.name,
      email: p.primaryEmail,
      country: p.country,
      tokenBalance: p.tokenBalance ?? 0,
      connectionCount: conns.Count ?? 0,
      createdAt: p.createdAt,
    };
  }));
  return full.filter(Boolean).sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
}

async function adminStats() {
  const users = await adminUsers(500);
  return {
    totalUsers: users.length,
    usersIndia: users.filter((u: any) => u.country === 'IN').length,
    usersInternational: users.filter((u: any) => u.country !== 'IN').length,
    tokensOutstanding: users.reduce((n: number, u: any) => n + (u.tokenBalance ?? 0), 0),
  };
}

async function adminInvitations(status?: string) {
  const statuses = status && status !== 'ALL'
    ? [status]
    : Object.values(k.INVITE_STATUS);
  const results = await Promise.all(statuses.map((s) =>
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': `INVITE_STATUS#${s}` },
      ScanIndexForward: false,
      Limit: 50,
    }))
  ));
  const now = Math.floor(Date.now() / 1000);
  return results.flatMap((r) => r.Items ?? [])
    .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((it: any) => {
      const live = it.status === k.INVITE_STATUS.PENDING;
      const refunded = (k.TERMINAL_REFUNDS_TOKEN as readonly string[]).includes(it.status);
      return {
        inviteId: it.inviteId,
        recipientEmail: it.recipientEmail,
        status: it.status,
        type: it.type,
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
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...k.pricingConfig(),
      entityType: 'CONFIG',
      tokensPerBundle: tokens,
      updatedAt: now,
      updatedBy: admin,
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

export const handler = async (event: AppSyncResolverEvent<any>) => {
  const admin = assertAdmin(event);
  const field = (event as any).info?.fieldName;
  const args = (event.arguments ?? {}) as any;

  switch (field) {
    case 'adminUsers': return adminUsers(args.limit ?? 50);
    case 'adminStats': return adminStats();
    case 'adminInvitations': return adminInvitations(args.status);
    case 'adminPricingConfig': return adminPricingConfig();
    case 'adminSetTokensPerBundle': return adminSetTokensPerBundle(admin, args.tokens);
    case 'adminAdjustTokens': return adminAdjustTokens(admin, args.userId, args.delta, args.reason);
    default: throw new Error(`Unknown field ${field}`);
  }
};
