import type { AppSyncResolverEvent } from 'aws-lambda';
import { QueryCommand, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { priceForCountry, formatMinor, coerceBundleSize } from '../../shared/pricing';
import * as k from '../../shared/keys';
import { send, invitationEmail } from '../../shared/email';
import {
  validateName, validateBio, validateDesignation, validateOrganisation, validateLocation,
  ValidationError,
} from '../../shared/validation';

const INVITE_COST = 1;

/** The caller's own id, taken from the verified Cognito claims — never from arguments. */
function callerId(event: any): string {
  const sub = event?.identity?.sub ?? event?.identity?.claims?.sub;
  if (!sub) throw new Error('Unauthorized');
  return sub;
}

async function loadProfile(userId: string) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(userId) }));
  if (!Item) throw new Error('Profile not found');
  return Item;
}

async function connectionRows(userId: string) {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': k.PREFIX.CONNECTION },
  }));
  return Items;
}

async function me(userId: string) {
  const [p, conns] = await Promise.all([loadProfile(userId), connectionRows(userId)]);
  return {
    userId,
    name: p.name,
    email: p.primaryEmail,
    designation: p.designation ?? null,
    organisation: p.organisation ?? null,
    location: p.location ?? null,
    bio: p.bio ?? null,
    country: p.country,
    tokenBalance: p.tokenBalance ?? 0,
    createdAt: p.createdAt,
    connectionCount: conns.length,
  };
}

async function myConnections(userId: string) {
  const rows = await connectionRows(userId);
  if (rows.length === 0) return [];
  // One read per contact. Fine at this size; becomes a BatchGet when it isn't.
  const profiles = await Promise.all(
    rows.map((r) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(r.otherUserId) })))
  );
  return rows.map((r, i) => {
    const p = profiles[i].Item ?? {};
    return {
      userId: r.otherUserId,
      name: p.name ?? 'Unknown',
      designation: p.designation ?? null,
      organisation: p.organisation ?? null,
      location: p.location ?? null,
      connectedAt: r.connectedAt,
    };
  });
}

function shapeInvite(it: any) {
  const now = Math.floor(Date.now() / 1000);
  const live = it.status === k.INVITE_STATUS.PENDING
    || it.status === k.INVITE_STATUS.PENDING_GATEKEEPER
    || it.status === k.INVITE_STATUS.INTRO_PENDING;
  const daysLeft = live && it.expiresAt
    ? Math.max(0, Math.ceil((Number(it.expiresAt) - now) / 86400))
    : null;
  const refunded = (k.TERMINAL_REFUNDS_TOKEN as readonly string[]).includes(it.status);
  return {
    inviteId: it.inviteId,
    recipientEmail: it.recipientEmail,
    status: it.status,
    type: it.type,
    createdAt: it.createdAt,
    expiresAt: it.expiresAt ?? null,
    daysLeft,
    tokenOutcome: refunded ? '1 token returned' : (live ? 'held' : '1 token spent'),
  };
}

async function myInvitations(userId: string) {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': k.PREFIX.INVITE },
    ScanIndexForward: false,
  }));
  return Items.map(shapeInvite);
}

/** Bundle size is set from BMS; absent or invalid falls back to the default. */
async function bundleSize(): Promise<number> {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.pricingConfig() }));
  return coerceBundleSize(Item?.tokensPerBundle);
}

async function tokenPrice(userId: string) {
  const [p, tokens] = await Promise.all([loadProfile(userId), bundleSize()]);
  const price = priceForCountry(p.country, tokens);
  return {
    ...price,
    baseDisplay: formatMinor(price.baseMinor, price.symbol),
    taxDisplay: price.taxMinor > 0 ? formatMinor(price.taxMinor, price.symbol) : null,
    totalDisplay: formatMinor(price.totalMinor, price.symbol),
  };
}

/**
 * Front-loaded token spend (§3.4): the balance drops the moment the invitation
 * is created, not when it is accepted.
 *
 * Debit, invitation and ledger entry go in ONE transaction, so a token can
 * never be spent without the invite that justifies it, nor an invite exist that
 * nobody paid for.
 *
 * The condition is `tokenBalance >= :cost`, not merely `attribute_exists` —
 * attribute_exists proves the row is there but happily drives the balance
 * negative under concurrent sends, which is exactly the parallel-queuing attack
 * the design exists to prevent.
 */
async function sendInvitation(userId: string, rawEmail: string) {
  const recipientEmail = k.normalizeEmail(rawEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) throw new Error('That does not look like an email address.');

  const profile = await loadProfile(userId);
  if (k.normalizeEmail(profile.primaryEmail) === recipientEmail) {
    throw new Error('You cannot invite yourself.');
  }

  const existing = await ddb.send(new GetCommand({
    TableName: TABLE_NAME, Key: k.emailOwnership(recipientEmail),
  }));
  if (existing.Item && existing.Item.userId === userId) throw new Error('That is your own address.');

  const inviteId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = k.inviteExpiryEpochSeconds();
  const status = k.INVITE_STATUS.PENDING;
  const balanceAfter = (profile.tokenBalance ?? 0) - INVITE_COST;

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: k.user(userId),
            UpdateExpression: 'ADD tokenBalance :neg',
            ConditionExpression: 'attribute_exists(PK) AND tokenBalance >= :cost',
            ExpressionAttributeValues: { ':neg': -INVITE_COST, ':cost': INVITE_COST },
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.invite(inviteId),
              entityType: 'INVITE',
              inviteId,
              senderId: userId,
              recipientEmail,
              status,
              type: 'DIRECT',
              tokenCharged: true,
              createdAt,
              expiresAt,
              ...k.gsi1Outbox(userId, createdAt, inviteId),
              ...k.gsi2Inbox(recipientEmail, status, createdAt),
              ...k.gsi3InviteStatus(status, createdAt, inviteId),
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.transaction(userId, createdAt),
              entityType: 'TXN',
              delta: -INVITE_COST,
              reason: k.TXN_REASON.INVITE_SENT,
              balanceAfter,
              relatedId: inviteId,
              actorId: userId,
              createdAt,
            },
          },
        },
      ],
    }));
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') {
      throw new Error('You do not have enough tokens to send an invitation.');
    }
    throw err;
  }

  // Sent after the transaction commits, never inside it. If delivery fails the
  // token stays spent and the invitation stands — the recipient can still be
  // reached, and the 7-day expiry will return the token if nothing comes of it.
  // Failing the mutation here would be worse: the caller would retry and spend
  // a second token on an invitation that already exists.
  const senderLine = [profile.designation, profile.organisation].filter(Boolean).join(', ')
    || 'They are on Flaunt.';
  const delivered = await send(invitationEmail({
    to: recipientEmail,
    senderName: profile.name,
    senderLine: `${profile.name}${senderLine ? ' — ' + senderLine : ''}`,
    inviteId,
  }));
  if (!delivered) {
    console.error(JSON.stringify({ msg: 'invitation created but email failed', inviteId, recipientEmail }));
  }

  return shapeInvite({ inviteId, recipientEmail, status, type: 'DIRECT', createdAt, expiresAt });
}

/**
 * Edits the caller's own profile. Never takes a userId — the row written is the
 * one the verified token identifies, so one member cannot write another's.
 *
 * Only the fields actually supplied are touched, so sending just a location
 * cannot blank a bio. The same validators the sign-up path uses run here, since
 * this is a second door onto the same data and a rule enforced on only one of
 * them is not enforced at all.
 *
 * The name is denormalised into normalizedName and the GSI3 search key, which
 * must move together with it or search would keep finding the old name.
 */
async function updateProfile(userId: string, args: any) {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  const put = (attr: string, value: any) => {
    names[`#${attr}`] = attr;
    values[`:${attr}`] = value;
    sets.push(`#${attr} = :${attr}`);
  };

  try {
    if (args.name !== undefined && args.name !== null) {
      const name = validateName(args.name);
      put('name', name);
      put('normalizedName', k.normalizeName(name));
      const g = k.gsi3NameSearch(name, userId);
      put('GSI3PK', g.GSI3PK);
      put('GSI3SK', g.GSI3SK);
    }
    if (args.designation !== undefined && args.designation !== null) {
      put('designation', validateDesignation(args.designation));
    }
    // Optional fields: an empty string means "clear it", which is a REMOVE
    // rather than writing an empty string that would render as a blank line.
    for (const [field, validate] of [
      ['organisation', validateOrganisation],
      ['location', validateLocation],
    ] as const) {
      if (args[field] !== undefined && args[field] !== null) {
        const v = validate(args[field]);
        if (v === undefined) { names[`#${field}`] = field; removes.push(`#${field}`); }
        else put(field, v);
      }
    }
    if (args.bio !== undefined && args.bio !== null) {
      put('bio', validateBio(args.bio));
    }
  } catch (err) {
    if (err instanceof ValidationError) throw new Error(err.message);
    throw err;
  }

  if (sets.length === 0 && removes.length === 0) return me(userId);

  const expr = [
    sets.length ? `SET ${sets.join(', ')}` : '',
    removes.length ? `REMOVE ${removes.join(', ')}` : '',
  ].filter(Boolean).join(' ');

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: k.user(userId),
    UpdateExpression: expr,
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  }));

  return me(userId);
}

export const handler = async (event: AppSyncResolverEvent<any>) => {
  const field = (event as any).info?.fieldName;
  const userId = callerId(event);
  const args = (event.arguments ?? {}) as any;

  switch (field) {
    case 'me': return me(userId);
    case 'myConnections': return myConnections(userId);
    case 'myInvitations': return myInvitations(userId);
    case 'tokenPrice': return tokenPrice(userId);
    case 'sendInvitation': return sendInvitation(userId, args.email);
    case 'updateProfile': return updateProfile(userId, args);
    // Name search needs the GSI3 NAME# namespace and the degree walk; until
    // that lands it returns nothing rather than something invented.
    case 'searchPeople': return [];
    default: throw new Error(`Unknown field ${field}`);
  }
};
