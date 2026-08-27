import type { DefineAuthChallengeTriggerHandler } from 'aws-lambda';

/** One code, at most three rounds, then the session is burned. */
const MAX_CHALLENGE_ROUNDS = 3;

export const handler: DefineAuthChallengeTriggerHandler = async (event) => {
  const session = event.request.session ?? [];
  const last = session[session.length - 1];

  if (last?.challengeName === 'CUSTOM_CHALLENGE' && last.challengeResult === true) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
    return event;
  }

  if (session.length >= MAX_CHALLENGE_ROUNDS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  event.response.issueTokens = false;
  event.response.failAuthentication = false;
  event.response.challengeName = 'CUSTOM_CHALLENGE';
  return event;
};
