import type { AppSyncResolverEvent } from 'aws-lambda';
import { QueryCommand, GetCommand, TransactWriteCommand, UpdateCommand, PutCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { priceForCountry, formatMinor, coerceBundleSize, coercePaymentMode } from '../../shared/pricing';
import { credentials, createOrder } from '../../shared/razorpay';
import * as k from '../../shared/keys';
import { send, invitationEmail, refundEmail, gatekeeperEmail, introForwardEmail } from '../../shared/email';
import {
  validateName, validateBio, validateDesignation, validateOrganisation, validateLocation,
  validateSecondaryEmail, ValidationError,
} from '../../shared/validation';

const INVITE_COST = 1;


/**
 * Counters are updated OUTSIDE the transaction, deliberately.
 *
 * A daily counter is one item that every write in the system touches, so
 * including it made concurrent operations conflict with each other rather than
 * with anything they actually contended for — a burst of sign-ups from one
 * country on one day failed outright, after Cognito had already created the
 * accounts. Load testing surfaced it at 30 concurrent sign-ups.
 *
 * These numbers are derived analytics. Nothing reads them to make a decision,
 * and the digest tolerates being slightly under. Losing one is immaterial;
 * failing a user's sign-up or refund to record one is not. Best effort, never
 * throws, never blocks.
 */
async function bumpCounter(key: { PK: string; SK: string }, expression: string, values: Record<string, number>) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME, Key: key, UpdateExpression: expression, ExpressionAttributeValues: values,
    }));
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'counter update skipped', key, err: String(err) }));
  }
}

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
    secondaryEmail: p.secondaryEmail ?? null,
    country: p.country,
    tokenBalance: p.tokenBalance ?? 0,
    createdAt: p.createdAt,
    connectionCount: conns.length,
  };
}

async function myConnections(userId: string) {
  const rows = await connectionRows(userId);
  if (rows.length === 0) return [];

  // Two reads per contact: their profile, and a COUNT of their own connections.
  // Select: 'COUNT' returns only the tally, so a well-connected contact costs
  // no more to display than a new one. Fine at this size; the profile read
  // becomes a BatchGet when it isn't.
  const [profiles, counts] = await Promise.all([
    Promise.all(rows.map((r) =>
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(r.otherUserId) })))),
    Promise.all(rows.map((r) =>
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `USER#${r.otherUserId}`, ':sk': k.PREFIX.CONNECTION },
        Select: 'COUNT',
      })))),
  ]);

  return rows.map((r, i) => {
    const p = profiles[i].Item ?? {};
    return {
      userId: r.otherUserId,
      name: p.name ?? 'Unknown',
      designation: p.designation ?? null,
      organisation: p.organisation ?? null,
      location: p.location ?? null,
      connectedAt: r.connectedAt,
      connectionCount: counts[i].Count ?? 0,
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

  // An introduction request is only meaningful with names on it: an email
  // address does not tell you who you asked to meet, or who you asked.
  const ids = [...new Set(Items.flatMap((i: any) =>
    i.type === 'INTRO' ? [i.targetUserId, i.gatekeeperId].filter(Boolean) : []))] as string[];
  const people = ids.length ? await hydrateMany(ids) : new Map();

  return Items.map((it: any) => ({
    ...shapeInvite(it),
    targetName: it.targetUserId ? (people.get(it.targetUserId)?.name ?? null) : null,
    gatekeeperName: it.gatekeeperId ? (people.get(it.gatekeeperId)?.name ?? null) : null,
    direction: 'SENT',
  }));
}

/**
 * Invitations addressed to the caller — the other half of their inbox.
 *
 * These were never queried anywhere: myInvitations reads the sender index, so
 * a member could see every invitation they had sent and none of the ones
 * waiting on them. Keyed by verified email, so it follows the address rather
 * than the account.
 */
async function incomingInvitations(userId: string) {
  const { Item: me } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(userId) }));
  const email = me?.primaryEmail;
  if (!email) return [];
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `EMAIL#${String(email).trim().toLowerCase()}` },
    ScanIndexForward: false,
    Limit: 100,
  }));
  const senderIds = [...new Set(Items.map((i: any) => i.senderId).filter(Boolean))] as string[];
  const senders = senderIds.length ? await hydrateMany(senderIds) : new Map();
  return Items.map((it: any) => ({
    ...shapeInvite(it, senders.get(it.senderId)),
    targetName: null,
    gatekeeperName: null,
    direction: 'RECEIVED',
  }));
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
    if (args.secondaryEmail !== undefined && args.secondaryEmail !== null) {
      const v = validateSecondaryEmail(args.secondaryEmail);
      if (v === undefined) { names['#secondaryEmail'] = 'secondaryEmail'; removes.push('#secondaryEmail'); }
      else put('secondaryEmail', v);
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
    ],
  }));

  await bumpCounter(k.statsGlobal(now.slice(0, 10)), 'ADD invitesAccepted :one', { ':one': 1 });
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
    ],
  }));

  const { Item: sender } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(inv.senderId) }));
  if (sender?.primaryEmail) {
    await send(refundEmail({ to: sender.primaryEmail, recipientEmail: inv.recipientEmail, reason: 'REJECTED' }));
  }
  await bumpCounter(k.statsGlobal(now.slice(0, 10)),
    'ADD invitesRejected :one, tokensRefunded :one', { ':one': 1 });
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

/**
 * One person's profile, graded by how far they are from the caller (§3.2).
 *
 * Degree is computed, never stored: persisting it would mean rewriting O(n²)
 * rows every time anyone connects.
 *
 * The walk is two queries, not a fan-out. The obvious implementation reads the
 * caller's contacts and then each of THEIR contacts — one query per contact,
 * on the hot path of every profile view. Reading both sides and intersecting
 * gets the same answer, and the same mutual connection the introduction flow
 * needs, in a fixed two reads however large the network grows.
 */
async function profile(callerId: string, targetId: string) {
  const target = await loadProfile(targetId);

  const base = {
    userId: targetId,
    name: target.name,
    designation: target.designation ?? null,
    // Title and employer are what a person publishes to be found
    // professionally, so they travel to every tier.
    organisation: target.organisation ?? null,
    bio: target.bio ?? null,
    country: target.country,
  };

  if (callerId === targetId) {
    return { ...base, location: target.location ?? null, primaryEmail: target.primaryEmail,
      secondaryEmail: target.secondaryEmail ?? null, degree: 0, viaName: null, viaUserId: null,
      viaOptions: [], connectedAt: null };
  }

  const { Item: direct } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME, Key: k.connection(callerId, targetId),
  }));
  if (direct) {
    return { ...base, location: target.location ?? null, primaryEmail: target.primaryEmail,
      secondaryEmail: target.secondaryEmail ?? null,
      secondaryEmailUnverified: Boolean(target.secondaryEmail),
      degree: 1, viaName: null, viaUserId: null, viaOptions: [],
      connectedAt: direct.connectedAt ?? null };
  }

  const [mine, theirs] = await Promise.all([connectionRows(callerId), connectionRows(targetId)]);
  const mineIds = new Set(mine.map((r: any) => r.otherUserId));
  /**
   * EVERY mutual connection, not the first one found.
   *
   * Who is asked is a real choice: one contact may know the target well and
   * another barely, and the requester is the only one who can judge that.
   * Returning a single arbitrary introducer quietly made that decision for them.
   */
  const mutualIds = theirs.map((r: any) => r.otherUserId).filter((id: string) => mineIds.has(id));

  if (mutualIds.length > 0) {
    const vias = await Promise.all(mutualIds.map((id: string) =>
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(id) }))));
    const viaOptions = mutualIds.map((id: string, i: number) => {
      const v = vias[i].Item ?? {};
      return {
        userId: id,
        name: v.name ?? 'Unknown',
        designation: [v.designation, v.organisation].filter(Boolean).join(' · ') || null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return {
      ...base,
      // Personal geography does not serve the "be found professionally" purpose
      // and narrows a person considerably, so it stops at the first degree.
      location: null,
      primaryEmail: k.maskEmail(target.primaryEmail),
      secondaryEmail: null,
      degree: 2,
      viaName: viaOptions[0]?.name ?? null,
      viaUserId: viaOptions[0]?.userId ?? null,
      viaOptions,
      connectedAt: null,
    };
  }

  // Third degree and beyond: name, what they do, nothing that reaches them.
  return { ...base, location: null, primaryEmail: null, secondaryEmail: null,
    degree: null, viaName: null, connectedAt: null };
}

/**
 * Removes a connection.
 *
 * Both mirrored rows go in one transaction. Deleting only the caller's side
 * would leave the other person still holding a row pointing at someone who no
 * longer lists them — a half-connection that the degree walk would read
 * differently depending on which end it started from.
 *
 * No token is returned: the token bought the introduction, and it happened.
 */
async function removeConnection(userId: string, otherId: string) {
  const { Item: existing } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME, Key: k.connection(userId, otherId),
  }));
  if (!existing) return true; // already gone

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName: TABLE_NAME, Key: k.connection(userId, otherId) } },
      { Delete: { TableName: TABLE_NAME, Key: k.connection(otherId, userId) } },
    ],
  }));
  return true;
}

/** Caps the fan-out below. See the note in secondDegree. */
/**
 * The connections of one of the caller's direct contacts — the people they
 * could ask that contact to introduce them to.
 *
 * Restricted to DIRECT contacts. Reading an arbitrary user's connection list
 * would expose the shape of the network to someone standing outside it, which
 * is the opposite of what the degree tiers exist for.
 *
 * Each person is returned with their degree relative to the CALLER, not to the
 * contact, and carries viaUserId so an introduction can be requested straight
 * from the row.
 */
async function connectionsOf(callerId: string, contactId: string) {
  const { Item: direct } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME, Key: k.connection(callerId, contactId),
  }));
  if (!direct) throw new Error('You can only see the connections of your direct contacts.');

  const [theirs, mine, contact] = await Promise.all([
    connectionRows(contactId), connectionRows(callerId), loadProfile(contactId),
  ]);
  const mineIds = new Set(mine.map((r: any) => r.otherUserId));

  const ids = theirs.map((r: any) => r.otherUserId).filter((id: string) => id !== callerId);
  if (ids.length === 0) return [];

  const people = await Promise.all(
    ids.map((id: string) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(id) })))
  );

  return ids.map((id: string, i: number) => {
    const p = people[i].Item ?? {};
    const isDirect = mineIds.has(id);
    return {
      userId: id,
      name: p.name ?? 'Unknown',
      designation: p.designation ?? null,
      organisation: p.organisation ?? null,
      location: isDirect ? (p.location ?? null) : null,
      bio: p.bio ?? null,
      country: p.country ?? '',
      primaryEmail: isDirect ? p.primaryEmail : k.maskEmail(p.primaryEmail ?? ''),
      secondaryEmail: isDirect ? (p.secondaryEmail ?? null) : null,
      secondaryEmailUnverified: isDirect ? Boolean(p.secondaryEmail) : null,
      connectedAt: null,
      degree: isDirect ? 1 : 2,
      viaName: isDirect ? null : contact.name,
      viaUserId: isDirect ? null : contactId,
      viaOptions: [],
    };
  }).sort((x: any, y: any) => String(x.name).localeCompare(String(y.name)));
}

const SECOND_DEGREE_FAN_OUT = 60;

/**
 * Profiles for many ids at once. BatchGet caps at 100 keys per call, so this
 * chunks and runs the chunks together rather than one read per person.
 */
async function hydrateMany(ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const results = await Promise.all(chunks.map((c) =>
    ddb.send(new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: c.map((id) => k.user(id)) } } }))));
  for (const r of results as any[]) {
    for (const item of (r.Responses?.[TABLE_NAME] ?? [])) {
      out.set(String(item.PK).replace('USER#', ''), item);
    }
  }
  return out;
}

/**
 * Everyone one step beyond the caller's direct contacts.
 *
 * This is the one genuinely expensive read in the app: it queries each direct
 * contact's connections, so it costs 1 + |contacts| queries. Resolving a SINGLE
 * profile's degree does not work this way — that intersects two contact lists
 * in two reads — but building the whole set has no such shortcut.
 *
 * So the fan-out is capped rather than unbounded. Past the cap the list is
 * incomplete rather than slow, which is the better failure for a browsing view;
 * the profile query stays exact, so nothing that matters is decided from a
 * truncated set.
 *
 * Emails are omitted entirely here. The masked address belongs on the profile,
 * where it is one person's detail, not sprayed across a list.
 */
async function secondDegree(userId: string, limit = 50, offset = 0, q?: string) {
  const mine = await connectionRows(userId);
  if (mine.length === 0) return { items: [], total: 0, hasMore: false };
  const direct = new Set(mine.map((r: any) => r.otherUserId));

  const lists = await Promise.all(
    mine.slice(0, SECOND_DEGREE_FAN_OUT).map(async (r: any) => ({
      viaId: r.otherUserId,
      rows: await connectionRows(r.otherUserId),
    }))
  );

  // First contact to reach someone becomes the introducer shown for them.
  const found = new Map<string, string>();
  for (const { viaId, rows } of lists) {
    for (const row of rows as any[]) {
      const id = row.otherUserId;
      if (id === userId || direct.has(id) || found.has(id)) continue;
      found.set(id, viaId);
    }
  }
  const total = found.size;
  if (total === 0) return { items: [], total: 0, hasMore: false };

  /**
   * The set is derived, not stored, so it has to be rebuilt to be sliced — the
   * membership above is cheap (ids only), and just the requested page is
   * hydrated into profiles below. That keeps the expensive part proportional to
   * the page, not the network.
   *
   * Ordering is by id rather than name because names are not loaded yet, and a
   * page boundary has to be stable between requests or a member would see
   * someone twice while never seeing someone else at all.
   */
  let ids = [...found.keys()].sort();
  let matchedTotal = total;

  /**
   * A search has to see the whole set, not the page.
   *
   * The client can only filter what it was sent, which for a member with
   * thousands of second-degree contacts is fifty rows — so a name three pages
   * down cannot be found at all. Names are not part of the derived set, so a
   * search hydrates every candidate once in order to filter on them. That is
   * the expensive path, which is why it runs only when something was typed.
   */
  const needle = String(q ?? '').trim().toLowerCase();
  if (needle) {
    const all = await hydrateMany(ids);
    ids = ids.filter((id) => {
      const p = all.get(id);
      if (!p) return false;
      return [p.name, p.designation, p.organisation]
        .filter(Boolean).some((f: any) => String(f).toLowerCase().includes(needle));
    }).sort((x, y) => String(all.get(x)?.name ?? '').localeCompare(String(all.get(y)?.name ?? '')));
    matchedTotal = ids.length;
  }

  const page = ids.slice(offset, offset + limit);
  if (page.length === 0) return { items: [], total: matchedTotal, hasMore: false };

  const viaIds = [...new Set(page.map((id) => found.get(id)!))];
  // One batched read for the page and its introducers together, rather than a
  // separate GetItem per person — a full page was fifty round trips plus one
  // per introducer, which is most of what made this screen feel slow.
  const fetched = await hydrateMany([...new Set([...page, ...viaIds])]);
  const people = page.map((id) => ({ Item: fetched.get(id) }));
  const viaName = new Map(viaIds.map((id) => [id, fetched.get(id)?.name ?? null]));

  const items = page.map((id, i) => {
    const p = people[i].Item ?? {};
    return {
      userId: id,
      name: p.name ?? 'Unknown',
      designation: p.designation ?? null,
      organisation: p.organisation ?? null,
      location: null,
      bio: p.bio ?? null,
      country: p.country ?? '',
      primaryEmail: null,
      secondaryEmail: null,
      secondaryEmailUnverified: null,
      connectedAt: null,
      degree: 2,
      viaName: viaName.get(found.get(id)!) ?? null,
      viaUserId: found.get(id) ?? null,
      viaOptions: [],
    };
  }).sort((x, y) => String(x.name).localeCompare(String(y.name)));

  return { items, total: matchedTotal, hasMore: offset + page.length < matchedTotal };
}

/**
 * Asks a mutual connection to make an introduction (§3.5).
 *
 * The token is spent here, at the request, not at the introduction — the
 * gatekeeper's attention is what is being paid for, and it is spent whether or
 * not they say yes. It comes back if they decline, if the target declines, or
 * if nobody responds within seven days.
 *
 * Both relationships are re-verified from the graph rather than trusted from
 * the arguments: the caller must be connected to the gatekeeper, and the
 * gatekeeper to the target. Otherwise anyone could name any pair and have the
 * request delivered.
 */
async function requestIntroduction(userId: string, targetUserId: string, viaUserId: string) {
  if (targetUserId === userId || viaUserId === userId) throw new Error('That is your own account.');
  if (targetUserId === viaUserId) throw new Error('Pick someone your contact is connected to.');

  const [{ Item: toVia }, { Item: viaToTarget }, { Item: alreadyMine }] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.connection(userId, viaUserId) })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.connection(viaUserId, targetUserId) })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.connection(userId, targetUserId) })),
  ]);
  if (!toVia) throw new Error('You are not connected to that person.');
  if (!viaToTarget) throw new Error('They are not connected to the person you want to meet.');
  if (alreadyMine) throw new Error('You are already connected.');

  const [requester, gatekeeper, target] = await Promise.all([
    loadProfile(userId), loadProfile(viaUserId), loadProfile(targetUserId),
  ]);

  const inviteId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = k.inviteExpiryEpochSeconds();
  const status = k.INVITE_STATUS.PENDING_GATEKEEPER;
  const recipientEmail = k.normalizeEmail(target.primaryEmail);

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
              entityType: 'INVITE', inviteId, senderId: userId,
              recipientEmail, recipientUserId: targetUserId,
              gatekeeperId: viaUserId, targetUserId,
              status, type: 'INTRO', tokenCharged: true, createdAt, expiresAt,
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
              entityType: 'TXN', delta: -INVITE_COST,
              reason: k.TXN_REASON.INTRO_REQUESTED, relatedId: inviteId,
              actorId: userId, createdAt,
            },
          },
        },
      ],
    }));
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') {
      throw new Error('You do not have enough tokens to request an introduction.');
    }
    throw err;
  }

  await send(gatekeeperEmail({
    to: gatekeeper.primaryEmail,
    gatekeeperName: gatekeeper.name,
    requesterName: requester.name,
    requesterLine: [requester.designation, requester.organisation].filter(Boolean).join(', '),
    targetName: target.name,
    targetLine: [target.designation, target.organisation].filter(Boolean).join(', '),
  }));

  return shapeInvite({ inviteId, recipientEmail, status, type: 'INTRO', createdAt, expiresAt });
}

/** Requests the caller must decide on, as the mutual connection. */
async function gatekeeperRequests(userId: string) {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI3',
    KeyConditionExpression: 'GSI3PK = :pk',
    ExpressionAttributeValues: { ':pk': `INVITE_STATUS#${k.INVITE_STATUS.PENDING_GATEKEEPER}` },
    ScanIndexForward: false,
    Limit: 50,
  }));
  const keys = Items.map((i: any) => ({ PK: i.PK, SK: i.SK }));
  if (keys.length === 0) return [];
  const full = await Promise.all(keys.map((key) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }))));
  const mine = full.map((r) => r.Item).filter((i: any) => i && i.gatekeeperId === userId) as any[];
  if (mine.length === 0) return [];

  const profiles = await Promise.all(mine.flatMap((i) => [
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(i.senderId) })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(i.targetUserId) })),
  ]));
  const now = Math.floor(Date.now() / 1000);
  return mine.map((i, idx) => {
    const req = profiles[idx * 2].Item ?? {};
    const tgt = profiles[idx * 2 + 1].Item ?? {};
    return {
      inviteId: i.inviteId, status: i.status, createdAt: i.createdAt,
      daysLeft: i.expiresAt ? Math.max(0, Math.ceil((Number(i.expiresAt) - now) / 86400)) : null,
      requesterName: req.name ?? 'Unknown',
      requesterDesignation: [req.designation, req.organisation].filter(Boolean).join(' · ') || null,
      requesterUserId: i.senderId,
      targetName: tgt.name ?? 'Unknown',
      targetDesignation: [tgt.designation, tgt.organisation].filter(Boolean).join(' · ') || null,
      targetUserId: i.targetUserId,
    };
  });
}

async function loadGatekeeperInvite(userId: string, inviteId: string) {
  const { Item: inv } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.invite(inviteId) }));
  if (!inv) throw new Error('That request no longer exists.');
  if (inv.gatekeeperId !== userId) throw new Error('That request is not yours to decide.');
  return inv;
}

/** Approving forwards the request to the target; the token stays spent. */
async function approveIntroduction(userId: string, inviteId: string, rawNote?: string) {
  const inv = await loadGatekeeperInvite(userId, inviteId);
  if (inv.status === k.INVITE_STATUS.INTRO_PENDING) return shapeInvite(inv);
  if (inv.status !== k.INVITE_STATUS.PENDING_GATEKEEPER) {
    throw new Error(`That request was already ${String(inv.status).toLowerCase().replace(/_/g, ' ')}.`);
  }

  const status = k.INVITE_STATUS.INTRO_PENDING;
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: k.invite(inviteId),
    UpdateExpression: 'SET #s = :s, approvedAt = :now, GSI2SK = :g2, GSI3PK = :g3pk, GSI3SK = :g3sk',
    ConditionExpression: 'attribute_exists(PK) AND #s = :prev',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s': status, ':prev': inv.status, ':now': new Date().toISOString(),
      ':g2': `${status}#${inv.createdAt}`,
      ':g3pk': `INVITE_STATUS#${status}`,
      ':g3sk': `${inv.createdAt}#${inviteId}`,
    },
  }));

  // A note is the whole point of a human introduction rather than a forwarded
  // form — it is the introducer putting their own credibility behind it. Kept
  // short so it reads as a vouch rather than a covering letter.
  const note = typeof rawNote === 'string' && rawNote.trim() !== ''
    ? rawNote.trim().slice(0, 600) : null;
  if (note) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME, Key: k.invite(inviteId),
      UpdateExpression: 'SET gatekeeperNote = :n',
      ExpressionAttributeValues: { ':n': note },
    }));
  }

  const [requester, gatekeeper] = await Promise.all([loadProfile(inv.senderId), loadProfile(userId)]);
  await send(introForwardEmail({
    to: inv.recipientEmail,
    requesterName: requester.name,
    requesterLine: [requester.designation, requester.organisation].filter(Boolean).join(', '),
    requesterBio: requester.bio ?? null,
    gatekeeperName: gatekeeper.name,
    note,
    inviteId,
  }));

  return shapeInvite({ ...inv, status });
}

/** Declining ends it and returns the requester's token. */
async function declineIntroduction(userId: string, inviteId: string) {
  const inv = await loadGatekeeperInvite(userId, inviteId);
  if (inv.status === k.INVITE_STATUS.GATEKEEPER_DENIED) return shapeInvite(inv);
  if (inv.status !== k.INVITE_STATUS.PENDING_GATEKEEPER) {
    throw new Error(`That request was already ${String(inv.status).toLowerCase().replace(/_/g, ' ')}.`);
  }

  const now = new Date().toISOString();
  const status = k.INVITE_STATUS.GATEKEEPER_DENIED;
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: { ...k.inviteRefundMarker(inviteId), entityType: 'INVITE_REFUND', refundedAt: now, reason: status },
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
          TableName: TABLE_NAME, Key: k.user(inv.senderId),
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
            entityType: 'TXN', delta: 1,
            reason: k.TXN_REASON.REFUND_GATEKEEPER_DENIED, relatedId: inviteId,
            actorId: 'SYSTEM', createdAt: now,
          },
        },
      },
    ],
  }));

  // The requester is told the answer, never who gave it or why.
  const sender = await loadProfile(inv.senderId);
  const target = await loadProfile(inv.targetUserId);
  if (sender.primaryEmail) {
    await send(refundEmail({
      to: sender.primaryEmail, recipientEmail: target.name, reason: 'GATEKEEPER_DENIED',
    }));
  }
  await bumpCounter(k.statsGlobal(now.slice(0, 10)), 'ADD tokensRefunded :one', { ':one': 1 });
  return shapeInvite({ ...inv, status });
}

/**
 * Opens a Razorpay order for one bundle.
 *
 * The amount is computed HERE from the caller's stored country, never taken
 * from the client — a browser-supplied price is a browser-supplied discount.
 *
 * The order is recorded before it is returned, and that record is what the
 * webhook checks. The Razorpay account is shared with CloudMeter, so both
 * products' events carry a valid signature against the same shared secret: a
 * valid signature proves the message came from Razorpay, not that the payment
 * was ours. The order row is what proves the second part.
 *
 * Nothing is credited here. The browser can be closed, lied to, or replayed;
 * only the webhook moves the balance.
 */
async function createPaymentOrder(userId: string) {
  const profile = await loadProfile(userId);
  const [{ Item: pricing }, { Item: payment }] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.pricingConfig() })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.paymentConfig() })),
  ]);

  const tokens = coerceBundleSize(pricing?.tokensPerBundle);
  const mode = coercePaymentMode(payment?.mode);
  const price = priceForCountry(profile.country, tokens);
  const creds = await credentials(mode);

  const receipt = `flaunt-${userId.slice(0, 8)}-${Date.now()}`;
  const order = await createOrder(creds, {
    amountMinor: price.totalMinor,
    currency: price.currency,
    receipt,
    notes: { userId, tokens: String(tokens), mode },
  });

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...k.payment(order.id),
      entityType: 'PAYMENT',
      orderId: order.id,
      userId,
      currency: price.currency,
      baseMinor: price.baseMinor,
      taxMinor: price.taxMinor,
      totalMinor: price.totalMinor,
      tokens,
      mode,
      status: 'CREATED',
      receipt,
      createdAt: new Date().toISOString(),
    },
  }));

  return {
    orderId: order.id,
    keyId: creds.keyId,
    amountMinor: price.totalMinor,
    currency: price.currency,
    tokens,
    mode,
  };
}

async function paymentMode() {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.paymentConfig() }));
  return coercePaymentMode(Item?.mode);
}

export const handler = async (event: AppSyncResolverEvent<any>) => {
  const field = (event as any).info?.fieldName;
  const userId = callerId(event);
  const args = (event.arguments ?? {}) as any;

  switch (field) {
    case 'me': return me(userId);
    case 'myConnections': return myConnections(userId);
    case 'secondDegree': return secondDegree(userId, args.limit ?? 50, args.offset ?? 0, args.q);
    case 'gatekeeperRequests': return gatekeeperRequests(userId);
    case 'requestIntroduction': return requestIntroduction(userId, args.targetUserId, args.viaUserId);
    case 'approveIntroduction': return approveIntroduction(userId, args.inviteId, args.note);
    case 'declineIntroduction': return declineIntroduction(userId, args.inviteId);
    case 'myInvitations': return myInvitations(userId);
    case 'incomingInvitations': return incomingInvitations(userId);
    case 'tokenPrice': return tokenPrice(userId);
    case 'paymentMode': return paymentMode();
    case 'invitation': return invitation(userId, args.inviteId);
    case 'profile': return profile(userId, args.userId);
    case 'connectionsOf': return connectionsOf(userId, args.userId);
    case 'acceptInvitation': return acceptInvitation(userId, args.inviteId);
    case 'declineInvitation': return declineInvitation(userId, args.inviteId);
    case 'cancelInvitation': return cancelInvitation(userId, args.inviteId);
    case 'removeConnection': return removeConnection(userId, args.userId);
    case 'sendInvitation': return sendInvitation(userId, args.email);
    case 'updateProfile': return updateProfile(userId, args);
    case 'createPaymentOrder': return createPaymentOrder(userId);
    // Name search needs the GSI3 NAME# namespace and the degree walk; until
    // that lands it returns nothing rather than something invented.
    case 'searchPeople': return [];
    default: throw new Error(`Unknown field ${field}`);
  }
};
