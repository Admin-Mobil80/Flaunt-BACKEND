import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { verifyWebhook , webhookSecretFor } from '../../shared/razorpay';
import { coercePaymentMode } from '../../shared/pricing';
import * as k from '../../shared/keys';

/**
 * Razorpay's webhook. The only place tokens are ever credited for money.
 *
 * Four checks, each closing a different hole:
 *
 * 1. HMAC signature over the RAW body. Re-serialising the parsed JSON would
 *    reorder keys and never match.
 * 2. The order must exist in OUR table. This Razorpay account is shared with
 *    CloudMeter, so their events arrive here carrying a perfectly valid
 *    signature against the same shared secret — a valid signature proves the
 *    message came from Razorpay, not that the payment was ours. Without this
 *    check a CloudMeter subscription payment would credit Flaunt tokens.
 * 3. The captured amount must equal the amount we recorded when the order was
 *    created, so a tampered or re-priced payment cannot buy a bundle cheaply.
 * 4. Exactly-once, by conditional put on the event id. Razorpay retries
 *    deliveries, and a retry must not credit twice.
 *
 * It answers 200 to anything it has decided not to act on. A non-2xx makes
 * Razorpay retry forever an event that will never be accepted.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const raw = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body ?? '');
  const signature = event.headers['x-razorpay-signature'] ?? event.headers['X-Razorpay-Signature'] ?? '';

  // The mode decides which webhook secret to verify against; test and live are
  // separate Razorpay environments with separate signing secrets.
  const { Item: paymentCfg } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME, Key: k.paymentConfig(),
  }));
  const mode = coercePaymentMode(paymentCfg?.mode);
  const signingSecret = await webhookSecretFor(mode);

  if (!verifyWebhook(raw, signature, signingSecret)) {
    console.warn(JSON.stringify({ msg: 'webhook signature rejected', mode }));
    return { statusCode: 401, body: 'invalid signature' };
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return { statusCode: 400, body: 'bad json' }; }

  const eventId = event.headers['x-razorpay-event-id'] ?? payload?.id ?? '';
  const eventType = payload?.event ?? 'unknown';
  const entity = payload?.payload?.payment?.entity ?? payload?.payload?.order?.entity ?? {};
  const orderId = entity.order_id ?? entity.id ?? '';
  const receivedAt = new Date().toISOString();

  const record = async (outcome: string, extra: Record<string, unknown> = {}) => {
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [{
        Put: {
          TableName: TABLE_NAME,
          Item: {
            ...k.webhookReceipt(eventId || `${orderId}-${receivedAt}`),
            entityType: 'WEBHOOK', eventType, orderId, signatureValid: true,
            outcome, mode, receivedAt,
            expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
            ...k.gsi3WebhookDay(receivedAt, eventId || orderId),
            ...extra,
          },
        },
      }] }));
    } catch { /* the trail is diagnostics; never fail the webhook over it */ }
  };

  if (eventType !== 'payment.captured' && eventType !== 'order.paid') {
    await record('IGNORED_EVENT_TYPE');
    return { statusCode: 200, body: 'ignored' };
  }

  const { Item: order } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME, Key: k.payment(orderId),
  }));
  if (!order) {
    // Almost certainly another product on this shared Razorpay account.
    await record('NOT_OURS');
    return { statusCode: 200, body: 'not ours' };
  }
  if (order.status === 'PAID') {
    await record('ALREADY_CREDITED');
    return { statusCode: 200, body: 'already credited' };
  }

  const paidMinor = Number(entity.amount ?? 0);
  if (paidMinor !== Number(order.totalMinor)) {
    console.error(JSON.stringify({
      msg: 'amount mismatch', orderId, expected: order.totalMinor, paid: paidMinor,
    }));
    await record('AMOUNT_MISMATCH', { paidMinor });
    return { statusCode: 200, body: 'amount mismatch' };
  }

  const now = new Date().toISOString();
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          // Exactly-once. A retried delivery fails the whole transaction here
          // rather than crediting a second time.
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.webhookReceipt(eventId || orderId),
              entityType: 'WEBHOOK', eventType, orderId, signatureValid: true,
              outcome: 'CREDITED', mode, receivedAt,
              expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
              ...k.gsi3WebhookDay(receivedAt, eventId || orderId),
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: TABLE_NAME, Key: k.payment(orderId),
            UpdateExpression: 'SET #s = :paid, paidAt = :now, paymentId = :pid',
            ConditionExpression: 'attribute_exists(PK) AND #s <> :paid',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':paid': 'PAID', ':now': now, ':pid': entity.id ?? null },
          },
        },
        {
          Update: {
            TableName: TABLE_NAME, Key: k.user(order.userId),
            UpdateExpression: 'ADD tokenBalance :t',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':t': Number(order.tokens) },
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.transaction(order.userId, now),
              entityType: 'TXN', delta: Number(order.tokens),
              reason: k.TXN_REASON.PURCHASE, relatedId: orderId,
              actorId: 'SYSTEM', createdAt: now,
            },
          },
        },
      ],
    }));
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') {
      // Another delivery of the same event won the race.
      return { statusCode: 200, body: 'already credited' };
    }
    throw err;
  }

  // Revenue counters, outside the transaction — one daily item shared by every
  // payment would make concurrent purchases conflict over a number nobody reads
  // to make a decision.
  try {
    const day = now.slice(0, 10);
    const isInr = order.currency === 'INR';
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME, Key: k.statsGlobal(day),
      UpdateExpression: isInr
        ? 'ADD revenueMinorInr :amt, gstMinorInr :tax, tokensPurchased :tok'
        : 'ADD revenueMinorUsd :amt, tokensPurchased :tok',
      ExpressionAttributeValues: isInr
        ? { ':amt': Number(order.totalMinor), ':tax': Number(order.taxMinor), ':tok': Number(order.tokens) }
        : { ':amt': Number(order.totalMinor), ':tok': Number(order.tokens) },
    }));
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'revenue counter skipped', err: String(err) }));
  }

  console.log(JSON.stringify({ msg: 'credited', orderId, userId: order.userId, tokens: order.tokens }));
  return { statusCode: 200, body: 'ok' };
};
