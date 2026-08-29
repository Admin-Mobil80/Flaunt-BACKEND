import { QueryCommand, ScanCommand, BatchWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import {
  CognitoIdentityProviderClient, AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ddb, TABLE_NAME } from './ddb';
import * as k from './keys';

const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

/** DynamoDB caps a batch write at 25, and pushes back what it could not do. */
async function deleteKeys(keys: Array<{ PK: string; SK: string }>) {
  for (let i = 0; i < keys.length; i += 25) {
    let req: any = { [TABLE_NAME]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    for (let attempt = 0; attempt < 6; attempt++) {
      const r: any = await ddb.send(new BatchWriteCommand({ RequestItems: req }));
      const un = r.UnprocessedItems ?? {};
      if (!un[TABLE_NAME]?.length) break;
      req = un;
      await new Promise((res) => setTimeout(res, 60 * (attempt + 1)));
    }
  }
}

export interface PurgeResult {
  found: boolean;
  email: string | null;
  rowsDeleted: number;
  connectionsRemoved: number;
  invitesRemoved: number;
}

/**
 * Removes a member and everything that points at them.
 *
 * A connection is two rows, one under each person. Deleting only the leaving
 * member's half would leave everyone they knew holding a row that resolves to
 * nobody — which renders as a blank name in a list and breaks the counts. So
 * every mirror row is deleted from the other side too.
 *
 * Invitations they sent go as well: an invitation still open when its sender
 * has gone would connect the recipient to an account that no longer exists.
 * Their tokens are not refunded to anyone — the ledger goes with the account.
 *
 * Ordered so the account cannot be signed into again before its data is gone:
 * Cognito last would leave a window where the profile is deleted but a live
 * session can still call the API.
 */
export async function purgeUser(userId: string, opts: {
  photoBucket?: string; userPoolId?: string;
} = {}): Promise<PurgeResult> {
  const { Item: profile } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME, Key: k.user(userId),
  }));
  if (!profile) return { found: false, email: null, rowsDeleted: 0, connectionsRemoved: 0, invitesRemoved: 0 };
  const email: string = profile.primaryEmail;

  // Sign-in first: no new session can start while the rest is being removed.
  if (opts.userPoolId && email) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: opts.userPoolId, Username: email }));
    } catch (err: any) {
      if (err?.name !== 'UserNotFoundException') throw err;
    }
  }

  // Everything filed under this member.
  const own: Array<{ PK: string; SK: string }> = [];
  const others: Array<{ PK: string; SK: string }> = [];
  let connections = 0;
  let ExclusiveStartKey: any = undefined;
  do {
    const r: any = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${userId}` },
      ExclusiveStartKey,
    }));
    for (const it of (r.Items ?? []) as any[]) {
      own.push({ PK: it.PK, SK: it.SK });
      if (it.entityType === 'CONNECTION' && it.otherUserId) {
        connections++;
        others.push(k.connection(it.otherUserId, userId) as any);
      }
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  // Their email claim and directory entry live outside their partition.
  if (email) own.push(k.emailOwnership(email) as any);

  // Invitations they sent, and any addressed to them.
  const invites: Array<{ PK: string; SK: string }> = [];
  let startKey: any = undefined;
  do {
    const r: any = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :t AND (senderId = :u OR recipientEmail = :e)',
      ExpressionAttributeValues: { ':t': 'INVITE', ':u': userId, ':e': email ?? '' },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: startKey,
    }));
    for (const it of (r.Items ?? []) as any[]) invites.push({ PK: it.PK, SK: it.SK });
    startKey = r.LastEvaluatedKey;
  } while (startKey);

  await deleteKeys([...own, ...others, ...invites]);

  if (opts.photoBucket) {
    try {
      await s3.send(new DeleteObjectsCommand({
        Bucket: opts.photoBucket,
        Delete: { Objects: ['sm', 'lg'].map((size) => ({ Key: `photos/${userId}/${size}.webp` })) },
      }));
    } catch { /* an orphaned image costs cents; the account is what matters */ }
  }

  return {
    found: true,
    email,
    rowsDeleted: own.length + others.length + invites.length,
    connectionsRemoved: connections,
    invitesRemoved: invites.length,
  };
}
