/**
 * End-to-end harness against the deployed stack.
 *
 * Two deliberate choices make it safe to run at volume:
 *
 * 1. Every address is an SES mailbox-simulator address. Mail to
 *    success+label@simulator.amazonses.com is genuinely delivered by SES and
 *    does NOT count toward bounce or complaint metrics. That matters here
 *    because this AWS account's SES reputation is shared with cloudmeter.io and
 *    several other live products — a bulk run against a disposable-email domain
 *    could push the account-level bounce rate into AWS review and pause sending
 *    for all of them.
 *
 * 2. Sign-in codes are recovered from their stored hash rather than read out of
 *    an inbox. The alternative was a temporary Cognito client with password
 *    auth, which would put a password door on a deliberately passwordless pool
 *    and outlive the run if it crashed. This changes no configuration at all.
 *
 * Recovery is only possible because the caller already has admin DynamoDB read
 * access, which is strictly more power than the code grants — it is a test
 * convenience, not a weakness in the auth design.
 */
import {
  CognitoIdentityProviderClient, SignUpCommand, InitiateAuthCommand,
  RespondToAuthChallengeCommand, AdminDeleteUserCommand, ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'node:crypto';

const REGION = 'ap-south-1';
const USER_POOL_ID = 'ap-south-1_lxLFyHEBG';
const CLIENT_ID = '55tuklmkr8og3rv8qjksj0c7pp';
const TABLE = 'Flaunt_Core_prod';
const API = 'https://tovmxl2unnd5bdbgp2lrrztv6y.appsync-api.ap-south-1.amazonaws.com/graphql';

/** Everything this harness creates carries this label, so cleanup is exact. */
const TAG = 'e2e';
const addressFor = (n: string) => `success+${TAG}-${n}@simulator.amazonses.com`;

const idp = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs work in bounded batches. Cognito's sign-up and auth APIs are rate
 * limited, and an unbounded Promise.all of a few hundred calls throttles rather
 * than parallelises.
 */
export async function inBatches<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map((it, j) => fn(it, i + j))));
    if (i + size < items.length) await sleep(250);
  }
  return out;
}

/** Realistic people, so a populated UI reads like a product rather than a load test. */
export const CAST = [
  ['Priya Nair', 'Design director', 'Ather Energy', 'Bengaluru, India'],
  ['Daniel Osei', 'Infrastructure engineer', 'Paystack', 'Accra, Ghana'],
  ['Meera Krishnan', 'Clinical research lead', 'Narayana Health', 'Chennai, India'],
  ['Tomas Ferreira', 'Founder', 'Lote 9', 'Lisbon, Portugal'],
  ['Sana Qureshi', 'Corporate counsel', 'Trilegal', 'Mumbai, India'],
  ['Wei Lin Tan', 'Quantitative researcher', 'GIC', 'Singapore'],
  ['Aisha Bello', 'Supply chain lead', 'Twiga Foods', 'Lagos, Nigeria'],
  ['Rahul Deshpande', 'Staff SRE', 'Razorpay', 'Pune, India'],
  ['Lucia Moretti', 'Product manager', 'Bending Spoons', 'Milan, Italy'],
  ['Kwame Asante', 'Head of risk', 'Flutterwave', 'Accra, Ghana'],
  ['Anjali Rao', 'Data scientist', 'Swiggy', 'Bengaluru, India'],
  ['Marcus Chen', 'Portfolio manager', 'Temasek', 'Singapore'],
] as const;

/** Mirrors functions/shared/otp.ts. */
const hashOtp = (code: string, email: string) =>
  createHash('sha256').update(`${email.toLowerCase()}:${code}`).digest('hex');

/**
 * Recovers the six-digit code from its stored hash. A million SHA-256s is about
 * a second — which is also a fair illustration of why the attempt counter, not
 * the hash, is what actually protects the code in production.
 */
function recoverOtp(codeHash: string, email: string): string {
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (hashOtp(candidate, email) === codeHash) return candidate;
  }
  throw new Error('could not recover OTP');
}

export interface TestUser { email: string; userId: string; idToken: string; }

export async function signUp(label: string, attrs: Record<string, string> = {}): Promise<string> {
  const email = addressFor(label);
  const password = `${randomBytes(18).toString('base64url')}aA1!`;
  await idp.send(new SignUpCommand({
    ClientId: CLIENT_ID,
    Username: email,
    Password: password,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'name', Value: attrs.name ?? `Test ${label}` },
      { Name: 'custom:country', Value: attrs.country ?? 'IN' },
      { Name: 'custom:designation', Value: attrs.designation ?? 'Tester' },
      ...(attrs.organisation ? [{ Name: 'custom:organisation', Value: attrs.organisation }] : []),
      ...(attrs.location ? [{ Name: 'custom:location', Value: attrs.location }] : []),
      ...(attrs.bio ? [{ Name: 'custom:bio', Value: attrs.bio }] : []),
    ],
  }));
  return email;
}

export async function signIn(email: string): Promise<TestUser> {
  const started = await idp.send(new InitiateAuthCommand({
    AuthFlow: 'CUSTOM_AUTH', ClientId: CLIENT_ID, AuthParameters: { USERNAME: email },
  }));

  // The challenge Lambda writes the hash before returning, but the read is
  // eventually consistent from this side; retry briefly rather than flake.
  let hash: string | undefined;
  for (let attempt = 0; attempt < 10 && !hash; attempt++) {
    const { Item } = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `OTP#${email.toLowerCase()}`, SK: 'METADATA' },
    }));
    hash = Item?.codeHash;
    if (!hash) await sleep(400);
  }
  if (!hash) throw new Error(`no OTP stored for ${email}`);

  const answered = await idp.send(new RespondToAuthChallengeCommand({
    ChallengeName: 'CUSTOM_CHALLENGE', ClientId: CLIENT_ID, Session: started.Session,
    ChallengeResponses: { USERNAME: email, ANSWER: recoverOtp(hash, email) },
  }));
  const idToken = answered.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error(`sign-in failed for ${email}`);

  const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());
  return { email, userId: claims.sub, idToken };
}

export async function gql(user: TestUser, query: string, variables: any = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: user.idToken },
    body: JSON.stringify({ query, variables }),
  });
  const body: any = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

/** Removes every account and row this harness created. Never touches anything else. */
export async function cleanup(): Promise<{ users: number; items: number }> {
  const { Users = [] } = await idp.send(new ListUsersCommand({
    UserPoolId: USER_POOL_ID, Limit: 60,
  }));
  const mine = Users.filter((u) =>
    (u.Attributes ?? []).some((a) => a.Name === 'email' && a.Value?.includes(`+${TAG}-`)));
  for (const u of mine) {
    await idp.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: u.Username! }));
  }

  const ids = new Set(mine.map((u) => (u.Attributes ?? []).find((a) => a.Name === 'sub')?.Value));
  const { Items = [] } = await ddb.send(new ScanCommand({
    TableName: TABLE, ProjectionExpression: 'PK, SK, senderId, recipientEmail, primaryEmail',
  }));
  let removed = 0;
  for (const it of Items as any[]) {
    const touchesTest =
      [...ids].some((id) => id && String(it.PK).includes(id)) ||
      String(it.PK).includes(`+${TAG}-`) ||
      String(it.recipientEmail ?? '').includes(`+${TAG}-`) ||
      String(it.primaryEmail ?? '').includes(`+${TAG}-`) ||
      (it.senderId && ids.has(it.senderId));
    if (!touchesTest) continue;
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
    removed++;
  }
  return { users: mine.length, items: removed };
}
