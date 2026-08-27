import type { CreateAuthChallengeTriggerHandler } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { generateOtp, hashOtp } from '../../shared/otp';

const ses = new SESClient({});
const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;
const OTP_TTL_SECONDS = 5 * 60;

/**
 * Fires on the first challenge and on every resend. Each call mints a fresh code
 * and overwrites the previous one for this address, so an older email in the
 * inbox stops working the moment a new one is requested.
 *
 * The stored item rides the table's `expiresAt` TTL, which sweeps used and
 * abandoned codes without a scheduled job.
 */
export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  const email = event.request.userAttributes?.email;

  /**
   * The account does not exist.
   *
   * preventUserExistenceErrors is enabled, so Cognito deliberately runs this
   * trigger anyway, with no email attribute, to make an unknown address behave
   * exactly like a known one. Reading `email` unguarded threw here, and the
   * resulting 500 was itself the disclosure the setting exists to prevent —
   * a crash for unknown addresses and a normal response for real ones is a
   * perfect account-enumeration oracle for a network whose whole premise is
   * that membership is private.
   *
   * So: issue a challenge that cannot be answered, send nothing, and let the
   * flow fail at verification like any wrong code.
   */
  if (!email) {
    event.response.publicChallengeParameters = { email: '' };
    event.response.privateChallengeParameters = {};
    event.response.challengeMetadata = 'OTP_EMAIL_NO_USER';
    return event;
  }

  const code = generateOtp();
  const now = Math.floor(Date.now() / 1000);

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `OTP#${email.toLowerCase()}`,
      SK: 'METADATA',
      entityType: 'OTP',
      codeHash: hashOtp(code, email),
      attempts: 0,
      createdAt: now,
      expiresAt: now + OTP_TTL_SECONDS,
    },
  }));

  await ses.send(new SendEmailCommand({
    Source: `Flaunt <${FROM_EMAIL}>`,
    Destination: { ToAddresses: [email] },
    Message: {
      // The code leads the subject line so it shows on a phone's lock screen —
      // most people read it there and never open the message.
      Subject: { Data: `${code} is your Flaunt sign-in code` },
      Body: {
        Text: { Data: `Your Flaunt one-time code is ${code}. It expires in 5 minutes.` },
        Html: {
          Data: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1F1B16">
            <p>Your Flaunt one-time code is:</p>
            <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#6E2B2B">${code}</p>
            <p style="color:#6B6459">It expires in 5 minutes. If you did not request it, you can ignore this email.</p>
          </div>`,
        },
      },
    },
  }));

  // Nothing secret goes in publicChallengeParameters — the client receives it.
  event.response.publicChallengeParameters = { email };
  event.response.privateChallengeParameters = {};
  event.response.challengeMetadata = 'OTP_EMAIL';
  return event;
};
