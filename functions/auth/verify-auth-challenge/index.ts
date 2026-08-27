import type { VerifyAuthChallengeResponseTriggerHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { hashOtp, otpMatches } from '../../shared/otp';

const MAX_ATTEMPTS = 5;

export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event) => {
  const email = event.request.userAttributes?.email;
  // No account: nothing was ever stored to compare against, and looking up
  // `OTP#undefined` would be a pointless read. Fail like any wrong code.
  if (!email) {
    event.response.answerCorrect = false;
    return event;
  }
  const submitted = (event.request.challengeAnswer ?? '').trim();
  const key = { PK: `OTP#${email.toLowerCase()}`, SK: 'METADATA' };

  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const now = Math.floor(Date.now() / 1000);

  // TTL deletion runs within ~48h of expiry rather than at it, so the timestamp
  // is checked here and the surviving row is treated as already dead.
  if (!Item || Item.expiresAt < now || Item.attempts >= MAX_ATTEMPTS) {
    event.response.answerCorrect = false;
    return event;
  }

  const correct = otpMatches(hashOtp(submitted, email), String(Item.codeHash));

  if (correct) {
    // Single use: the code dies with the sign-in it authorised.
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET attempts = attempts + :one',
      ExpressionAttributeValues: { ':one': 1 },
    }));
  }

  event.response.answerCorrect = correct;
  return event;
};
