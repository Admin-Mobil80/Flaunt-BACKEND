import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomBytes } from 'node:crypto';

const cognito = new CognitoIdentityProviderClient({});

/**
 * Creates the single BMS admin on stack create/update, and is a no-op if the
 * user already exists — CloudFormation replays custom resources on every update,
 * so this must be idempotent or a redeploy would fail the stack.
 *
 * Delete is deliberately a no-op: tearing the stack down should not silently
 * remove the only identity that can reach the console.
 */
export const handler = async (event: any) => {
  const { RequestType, ResourceProperties } = event;
  const UserPoolId = ResourceProperties.UserPoolId as string;
  const Email = String(ResourceProperties.Email).toLowerCase();

  if (RequestType === 'Delete') {
    return { PhysicalResourceId: `bms-root-${Email}` };
  }

  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId, Username: Email }));
    return { PhysicalResourceId: `bms-root-${Email}`, Data: { Status: 'AlreadyExists' } };
  } catch (err: any) {
    if (err?.name !== 'UserNotFoundException') throw err;
  }

  await cognito.send(new AdminCreateUserCommand({
    UserPoolId,
    Username: Email,
    UserAttributes: [
      { Name: 'email', Value: Email },
      { Name: 'email_verified', Value: 'true' },
    ],
    // No invite mail: the sign-in flow emails a code on demand, so an invite
    // would just be a message with nothing actionable in it.
    MessageAction: 'SUPPRESS',
  }));

  // Moves the account out of FORCE_CHANGE_PASSWORD so CUSTOM_AUTH will start.
  // Random, discarded, and unusable — the app client has no password flow.
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId,
    Username: Email,
    Password: `${randomBytes(24).toString('base64url')}aA1!`,
    Permanent: true,
  }));

  return { PhysicalResourceId: `bms-root-${Email}`, Data: { Status: 'Created' } };
};
