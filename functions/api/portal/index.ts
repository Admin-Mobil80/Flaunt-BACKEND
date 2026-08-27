import type { AppSyncResolverEvent } from 'aws-lambda';
import { QueryCommand, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { priceForCountry, formatMinor, coerceBundleSize } from '../../shared/pricing';
import * as k from '../../shared/keys';
import { send, invitationEmail, refundEmail } from '../../shared/email';
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

function shapeInvite(it: any, sender?: any) {
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
    senderName: sender?.name ?? it.senderName ?? null,
    senderDesignation: sender
      ? [sender.designation, sender.organisation].filter(Boolean).join(', ') || null
      : null,
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
    // Already looked up above for the self-invite guard.
    hasAccount: Boolean(existing.Item),
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

/**
 * Loads an invitation for the caller, refusing any that was not addressed to
 * them. The invite id travels in a link, so possession of it cannot be the
 * check — the caller's verified email has to match the recipient, or anyone
 * holding a forwarded link could take someone else's place in the network.
 */
async function loadInvitationFor(userId: string, inviteId: string) {
  const profile = await loadProfile(userId);
  const { Item: inv } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.invite(inviteId) }));
  if (!inv) throw new Error('That invitation no longer exists.');
  if (k.normalizeEmail(inv.recipientEmail) !== k.normalizeEmail(profile.primaryEmail)) {
    throw new Error('That invitation was sent to a different email address.');
  }
  return { profile, inv };
}

async function invitation(userId: string, inviteId: string) {
  const { inv } = await loadInvitationFor(userId, inviteId);
  const { Item: sender } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(inv.senderId) }));
  return shapeInvite(inv, sender);
}

const OPEN_STATUSES = [
  k.INVITE_STATUS.PENDING, k.INVITE_STATUS.PENDING_GATEKEEPER, k.INVITE_STATUS.INTRO_PENDING,
] as readonly string[];

/**
 * Accepts an invitation and forms the connection.
 *
 * Connections are stored as a MIRRORED PAIR — one row under each party — written
 * in the same transaction as the status change. A single row plus an index would
 * make one direction eventually consistent, so a brand-new contact could be
 * invisible to the very graph walk that gates introductions.
 *
 * `expiresAt` is removed here, not merely ignored. Leaving it would let TTL
 * delete an accepted invitation and hand the sender back a token they legitimately
 * spent; the stream handler also guards on status, but the attribute should not
 * survive the transition that makes it meaningless.
 */
async function acceptInvitation(userId: string, inviteId: string) {
  const { profile, inv } = await loadInvitationFor(userId, inviteId);

  // Idempotent: a double-tap or a retried request must not write the pair twice.
  if (inv.status === k.INVITE_STATUS.ACCEPTED) return shapeInvite(inv);
  if (!OPEN_STATUSES.includes(inv.status)) {
    throw new Error(`That invitation was already ${String(inv.status).toLowerCase()}.`);
  }
  if (inv.expiresAt && k.isExpired(Number(inv.expiresAt))) {
    throw new Error('That invitation has expired. Ask them to send a new one.');
  }
  if (inv.senderId === userId) throw new Error('You cannot accept your own invitation.');

  const now = new Date().toISOString();
  const status = k.INVITE_STATUS.ACCEPTED;

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE_NAME,
          Key: k.invite(inviteId),
          UpdateExpression:
            'SET #s = :s, acceptedAt = :now, recipientUserId = :uid, GSI2SK = :g2, GSI3PK = :g3pk, GSI3SK = :g3sk REMOVE expiresAt',
          ConditionExpression: 'attribute_exists(PK) AND #s = :prev',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':s': status, ':prev': inv.status, ':now': now, ':uid': userId,
            ':g2': `${status}#${inv.createdAt}`,
            ':g3pk': `INVITE_STATUS#${status}`,
            ':g3sk': `${inv.createdAt}#${inviteId}`,
          },
        },
      },
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            ...k.connection(inv.senderId, userId),
            entityType: 'CONNECTION', otherUserId: userId,
            relationshipDegree: 1, connectedAt: now, viaInviteId: inviteId,
          },
        },
      },
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            ...k.connection(userId, inv.senderId),
            entityType: 'CONNECTION', otherUserId: inv.senderId,
            relationshipDegree: 1, connectedAt: now, viaInviteId: inviteId,
          },
        },
      },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: k.statsGlobal(now.slice(0, 10)),
          UpdateExpression: 'ADD invitesAccepted :one',
          ExpressionAttributeValues: { ':one': 1 },
        },
      },
    ],
  }));

  return shapeInvite({ ...inv, status, expiresAt: null });
}

/**
 * Declines, and returns the sender's token (§3.4).
 *
 * The refund carries the same exactly-once marker the expiry path uses, so an
 * invitation cannot be refunded twice by being declined and then expiring.
 */
async function declineInvitation(userId: string, inviteId: string) {
  const { inv } = await loadInvitationFor(userId, inviteId);
  if (inv.status === k.INVITE_STATUS.REJECTED) return shapeInvite(inv);
  if (!OPEN_STATUSES.includes(inv.status)) {
    throw new Error(`That invitation was already ${String(inv.status).toLowerCase()}.`);
  }

  const now = new Date().toISOString();
  const status = k.INVITE_STATUS.REJECTED;

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: { ...k.inviteRefundMarker(inviteId), entityType: 'INVITE_REFUND', refundedAt: now, reason: 'REJECTED' },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: k.invite(inviteId),
          UpdateExpression:
            'SET #s = :s, GSI2SK = :g2, GSI3PK = :g3pk, GSI3SK = :g3sk REMOVE expiresAt',
          ConditionExpression: 'attribute_exists(PK) AND #s = :prev',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':s': status, ':prev': inv.status,
            ':g2': `${status}#${inv.createdAt}`,
            ':g3pk': `INVITE_STATUS#${status}`,
            ':g3sk': `${inv.createdAt}#${inviteId}`,
          },
        },
      },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: k.user(inv.senderId),
          UpdateExpression: 'ADD tokenBalance :one',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':one': 1 },
        },
      },
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            ...k.transaction(inv.senderId, now),
            entityType: 'TXN', delta: 1, reason: k.TXN_REASON.REFUND_REJECTED,
            relatedId: inviteId, actorId: 'SYSTEM', createdAt: now,
          },
        },
      },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: k.statsGlobal(now.slice(0, 10)),
          UpdateExpression: 'ADD invitesRejected :one, tokensRefunded :one',
          ExpressionAttributeValues: { ':one': 1 },
        },
      },
    ],
  }));

  const { Item: sender } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(inv.senderId) }));
  if (sender?.primaryEmail) {
    await send(refundEmail({ to: sender.primaryEmail, recipientEmail: inv.recipientEmail, reason: 'REJECTED' }));
  }
  return shapeInvite({ ...inv, status, expiresAt: null });
}

/**
 * Withdraws an invitation the caller sent, while it is still open, and returns
 * their token.
 *
 * Authorization is the mirror of accept: there the caller must be the
 * recipient, here they must be the SENDER. It reuses the same exactly-once
 * refund marker, so an invitation cannot be cancelled and then also refunded by
 * expiry, and expiresAt is removed so TTL has nothing left to act on.
 */
async function cancelInvitation(userId: string, inviteId: string) {
  const { Item: inv } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.invite(inviteId) }));
  if (!inv) throw new Error('That invitation no longer exists.');
  if (inv.senderId !== userId) throw new Error('You can only cancel invitations you sent.');
  if (inv.status === k.INVITE_STATUS.CANCELLED) return shapeInvite(inv);
  if (!OPEN_STATUSES.includes(inv.status)) {
    throw new Error(`That invitation was already ${String(inv.status).toLowerCase()} and cannot be cancelled.`);
  }

  const now = new Date().toISOString();
  const status = k.INVITE_STATUS.CANCELLED;

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: { ...k.inviteRefundMarker(inviteId), entityType: 'INVITE_REFUND', refundedAt: now, reason: 'CANCELLED' },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: k.invite(inviteId),
            UpdateExpression: 'SET #s = :s, GSI2SK = :g2, GSI3PK = :g3pk, GSI3SK = :g3sk REMOVE expiresAt',
            ConditionExpression: 'attribute_exists(PK) AND #s = :prev',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':s': status, ':prev': inv.status,
              ':g2': `${status}#${inv.createdAt}`,
              ':g3pk': `INVITE_STATUS#${status}`,
              ':g3sk': `${inv.createdAt}#${inviteId}`,
            },
          },
        },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: k.user(userId),
            UpdateExpression: 'ADD tokenBalance :one',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.transaction(userId, now),
              entityType: 'TXN', delta: 1, reason: k.TXN_REASON.REFUND_CANCELLED,
              relatedId: inviteId, actorId: userId, createdAt: now,
            },
          },
        },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: k.statsGlobal(now.slice(0, 10)),
            UpdateExpression: 'ADD invitesCancelled :one, tokensRefunded :one',
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
      ],
    }));
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') {
      throw new Error('That invitation has already been resolved.');
    }
    throw err;
  }

  return shapeInvite({ ...inv, status, expiresAt: null });
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
    case 'invitation': return invitation(userId, args.inviteId);
    case 'acceptInvitation': return acceptInvitation(userId, args.inviteId);
    case 'declineInvitation': return declineInvitation(userId, args.inviteId);
    case 'cancelInvitation': return cancelInvitation(userId, args.inviteId);
    case 'sendInvitation': return sendInvitation(userId, args.email);
    case 'updateProfile': return updateProfile(userId, args);
    // Name search needs the GSI3 NAME# namespace and the degree walk; until
    // that lands it returns nothing rather than something invented.
    case 'searchPeople': return [];
    default: throw new Error(`Unknown field ${field}`);
  }
};
