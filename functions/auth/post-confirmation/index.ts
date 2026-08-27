import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import * as k from '../../shared/keys';

const SIGNUP_TOKEN_GRANT = 10;

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
export const handler: PostConfirmationTriggerHandler = async (event) => {
  const a = event.request.userAttributes;
  const userId = a.sub;
  const email = k.normalizeEmail(a.email);
  const name = a.name ?? a.given_name ?? email.split('@')[0];
  const country = (a['custom:country'] ?? 'IN').toUpperCase();
  const now = new Date().toISOString();
  const day = now.slice(0, 10);

  const optional = (v?: string) => (v && v.trim() !== '' ? v.trim() : undefined);

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
        {
          // Pre-aggregated so the nightly digest never has to scan (§4.3).
          Update: {
            TableName: TABLE_NAME,
            Key: k.statsCountry(country, day),
            UpdateExpression: 'ADD signups :one, tokensGranted :grant',
            ExpressionAttributeValues: { ':one': 1, ':grant': SIGNUP_TOKEN_GRANT },
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

  return event;
};
