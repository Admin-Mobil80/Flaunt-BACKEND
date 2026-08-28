import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RAZORPAY_SECRET_BY_MODE, PaymentMode } from './pricing';

const secrets = new SecretsManagerClient({});

export interface RazorpayCreds { keyId: string; keySecret: string; webhookSecret: string; }

/**
 * Cached per mode for the life of the container. Secrets Manager is charged per
 * call and rate limited, and a checkout that fetches credentials on every order
 * adds latency to the one flow where it is least welcome.
 */
const cache = new Map<PaymentMode, RazorpayCreds>();

export async function credentials(mode: PaymentMode): Promise<RazorpayCreds> {
  const hit = cache.get(mode);
  if (hit) return hit;
  const name = RAZORPAY_SECRET_BY_MODE[mode];
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
  if (!SecretString) throw new Error(`Secret ${name} is empty`);
  const parsed = JSON.parse(SecretString);
  const creds: RazorpayCreds = {
    keyId: parsed.keyId, keySecret: parsed.keySecret, webhookSecret: parsed.webhookSecret,
  };
  if (!creds.keyId || !creds.keySecret) throw new Error(`Secret ${name} is missing keyId/keySecret`);
  cache.set(mode, creds);
  return creds;
}

export interface RazorpayOrder { id: string; amount: number; currency: string; status: string; }

/**
 * Creates an order. `amount` is in the currency's atomic unit — paise or
 * cents — which is what Razorpay expects and what the pricing module already
 * carries end to end, so no rounding happens here.
 *
 * `notes.product` marks the order as Flaunt's. The Razorpay account is shared
 * with CloudMeter, and this is the marker the webhook uses as a second check
 * alongside looking the order up in our own table.
 */
export async function createOrder(creds: RazorpayCreds, opts: {
  amountMinor: number; currency: string; receipt: string; notes: Record<string, string>;
}): Promise<RazorpayOrder> {
  const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      amount: opts.amountMinor,
      currency: opts.currency,
      receipt: opts.receipt,
      notes: { ...opts.notes, product: 'flaunt' },
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.description || `Razorpay order failed (${res.status})`);
  }
  return body;
}

/**
 * Verifies a webhook signature.
 *
 * Constant-time, and against the RAW body — re-serialising the parsed JSON
 * would reorder or reformat keys and the digest would never match, which is the
 * classic way webhook verification is broken while appearing implemented.
 */
export function verifyWebhook(rawBody: string, signature: string, webhookSecret: string): boolean {
  if (!signature || !webhookSecret) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
