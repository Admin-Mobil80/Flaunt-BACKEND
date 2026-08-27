import type { PreSignUpTriggerHandler } from 'aws-lambda';

/**
 * Auto-confirms sign-up. Ownership of the address is proved by the CUSTOM_AUTH
 * OTP the user must pass to obtain any token, so Cognito's own confirmation-code
 * step would be a second code for the same fact — two emails, two codes, one
 * verification.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
