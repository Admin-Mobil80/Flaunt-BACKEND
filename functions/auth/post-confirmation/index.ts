import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { TransactWriteCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import * as k from '../../shared/keys';
import { coerceSignupGrant } from '../../shared/pricing';

/**
 * Read per sign-up rather than cached: the value changes rarely, but a stale
 * copy in a warm Lambda would keep granting the old amount after an admin
 * changed it, with nothing to indicate why.
 */
async function signupGrant(): Promise<number> {
  try {
    const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: k.pricingConfig() }));
    return coerceSignupGrant(Item?.signupTokens);
  } catch {
    return coerceSignupGrant(undefined);
  }
}

/**
 * Creates the member's profile and grants their opening tokens (PRD §3.1).
 *
 * Everything happens in ONE TransactWriteItems, so the four facts that must be
 * true together cannot come apart: the profile exists, the email is claimed,
 * the balance is exactly 10, and the ledger records why. A partial write here
 * would leave an account that either cannot be found by email or holds tokens
 * with no entry explaining them.
 *
 * It is also idempotent. Cognito retries triggers, and a replay must not grant
 * a second 10 tokens — the conditional put on the profile makes a repeat
 * transaction fail as a whole rather than top the balance up again.
 */

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

export const handler: PostConfirmationTriggerHandler = async (event) => {
  const a = event.request.userAttributes;
  const userId = a.sub;
  const email = k.normalizeEmail(a.email);
  const name = a.name ?? a.given_name ?? email.split('@')[0];
  const country = (a['custom:country'] ?? 'IN').toUpperCase();
  const now = new Date().toISOString();
  const day = now.slice(0, 10);

  const optional = (v?: string) => (v && v.trim() !== '' ? v.trim() : undefined);
  const SIGNUP_TOKEN_GRANT = await signupGrant();

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.user(userId),
              entityType: 'USER',
              name,
              normalizedName: k.normalizeName(name),
              designation: optional(a['custom:designation']),
              organisation: optional(a['custom:organisation']),
              location: optional(a['custom:location']),
              bio: optional(a['custom:bio']),
              country,
              primaryEmail: email,
              tokenBalance: SIGNUP_TOKEN_GRANT,
              createdAt: now,
              ...k.gsi3NameSearch(name, userId),
            },
            // The guard that makes a retried trigger a no-op instead of a
            // second grant.
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          // Base-table item, not a GSI entry: uniqueness has to be enforced by
          // a condition on the primary key, and an eventually-consistent index
          // cannot do that.
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.emailOwnership(email),
              entityType: 'EMAIL',
              userId,
              kind: 'PRIMARY',
              verified: true,
              createdAt: now,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.userDirectory(userId),
              entityType: 'USER_DIRECTORY',
              name,
              country,
              createdAt: now,
              ...k.gsi3UserDirectory(country, now, userId),
            },
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              ...k.transaction(userId, now),
              entityType: 'TXN',
              delta: SIGNUP_TOKEN_GRANT,
              reason: k.TXN_REASON.SIGNUP_GRANT,
              balanceAfter: SIGNUP_TOKEN_GRANT,
              actorId: 'SYSTEM',
              createdAt: now,
            },
          },
        },
      ],
    }));
  } catch (err: any) {
    // A cancelled transaction here means the profile already existed — a
    // retried trigger. That is success, not failure: throwing would fail the
    // user's sign-up over work that is already done.
    const cancelled = err?.name === 'TransactionCanceledException';
    const onlyConditionFailures = (err?.CancellationReasons ?? [])
      .some((r: any) => r?.Code === 'ConditionalCheckFailed');
    if (!(cancelled && onlyConditionFailures)) throw err;
    console.log(JSON.stringify({ msg: 'profile already provisioned, skipping', userId }));
  }

  await bumpCounter(k.statsCountry(country, day),
    'ADD signups :one, tokensGranted :grant', { ':one': 1, ':grant': SIGNUP_TOKEN_GRANT });

  return event;
};
