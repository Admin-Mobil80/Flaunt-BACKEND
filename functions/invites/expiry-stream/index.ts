import type { DynamoDBStreamHandler, DynamoDBRecord } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { TransactWriteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { send, refundEmail } from '../../shared/email';
import * as k from '../../shared/keys';

const REFUND = 1;

/**
 * Returns the token when an invitation expires (§3.4).
 *
 * DynamoDB TTL deletes the row and the stream carries the OLD_IMAGE, which is
 * the only remaining evidence of who spent the token and on what — the row it
 * describes no longer exists.
 *
 * Three guards, each for a failure that would otherwise be silent:
 *
 * 1. Only TTL deletions refund. An ordinary delete also emits REMOVE, so the
 *    principal is checked — `dynamodb.amazonaws.com` is TTL's own identity.
 * 2. Only genuinely-pending invitations refund. Terminal transitions strip
 *    `expiresAt`, but a row that slipped through would otherwise hand back a
 *    token an accepted invitation legitimately consumed.
 * 3. The refund is exactly-once. Streams deliver at least once, so a conditional
 *    marker put rides inside the transaction: a replay fails the whole
 *    transaction rather than crediting twice.
 */
function isTtlDeletion(r: DynamoDBRecord): boolean {
  return r.eventName === 'REMOVE'
    && (r as any).userIdentity?.principalId === 'dynamodb.amazonaws.com'
    && (r as any).userIdentity?.type === 'Service';
}

export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (!isTtlDeletion(record)) continue;

    const old = record.dynamodb?.OldImage;
    if (!old) continue;
    const item: any = unmarshall(old as any);

    if (item.entityType !== 'INVITE' || item.SK !== 'METADATA') continue;

    const refundable = (k.TERMINAL_REFUNDS_TOKEN as readonly string[]).includes(item.status)
      || item.status === k.INVITE_STATUS.PENDING
      || item.status === k.INVITE_STATUS.PENDING_GATEKEEPER
      || item.status === k.INVITE_STATUS.INTRO_PENDING;
    if (!refundable || item.status === k.INVITE_STATUS.ACCEPTED) {
      console.log(JSON.stringify({ msg: 'not refundable, skipping', inviteId: item.inviteId, status: item.status }));
      continue;
    }
    if (!item.tokenCharged) continue;

    const now = new Date().toISOString();
    const expiredAt = Math.floor(Date.now() / 1000);

    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            // Exactly-once guard. If this marker exists the whole transaction
            // is rejected, so a replayed batch cannot refund twice.
            Put: {
              TableName: TABLE_NAME,
              Item: { ...k.inviteRefundMarker(item.inviteId), entityType: 'INVITE_REFUND', refundedAt: now, reason: 'EXPIRED' },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: k.user(item.senderId),
              UpdateExpression: 'ADD tokenBalance :one',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeValues: { ':one': REFUND },
            },
          },
          {
            // TTL deleted the row, so without this the expiry has no record at
            // all — BMS and the digest would simply lose it.
            Put: {
              TableName: TABLE_NAME,
              Item: {
                ...k.inviteArchive(item.inviteId),
                entityType: 'INVITE_ARCHIVE',
                inviteId: item.inviteId,
                senderId: item.senderId,
                recipientEmail: item.recipientEmail,
                status: k.INVITE_STATUS.EXPIRED,
                type: item.type,
                createdAt: item.createdAt,
                expiredAt,
                ...k.gsi3InviteStatus(k.INVITE_STATUS.EXPIRED, item.createdAt, item.inviteId),
              },
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                ...k.transaction(item.senderId, now),
                entityType: 'TXN',
                delta: REFUND,
                reason: k.TXN_REASON.REFUND_EXPIRED,
                relatedId: item.inviteId,
                actorId: 'SYSTEM',
                createdAt: now,
              },
            },
          },
        ],
      }));
      console.log(JSON.stringify({ msg: 'refunded expired invitation', inviteId: item.inviteId, senderId: item.senderId }));
    } catch (err: any) {
      if (err?.name === 'TransactionCanceledException') {
        // Already refunded by an earlier delivery of this same record.
        console.log(JSON.stringify({ msg: 'already refunded, skipping', inviteId: item.inviteId }));
        continue;
      }
      throw err;
    }

    // Outside the transaction: a whole TTL batch shares one daily counter item,
    // so including it made expiries conflict with each other and lose refunds.
    // The counter is analytics; the refund is money.
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME, Key: k.statsGlobal(now.slice(0, 10)),
        UpdateExpression: 'ADD invitesExpired :one, tokensRefunded :one',
        ExpressionAttributeValues: { ':one': 1 },
      }));
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'counter update skipped', err: String(err) }));
    }

    // After the ledger, and never blocking it: the money movement is committed
    // whether or not this message lands.
    const { Item: sender } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.user(item.senderId) }));
    if (sender?.primaryEmail) {
      await send(refundEmail({
        to: sender.primaryEmail,
        recipientEmail: item.recipientEmail,
        reason: 'EXPIRED',
      }));
    }
  }
};
