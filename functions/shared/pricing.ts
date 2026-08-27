/**
 * Token bundle pricing (PRD §3.3).
 *
 * This module is the single source of truth for what a bundle costs. The same
 * numbers must reach three places — the price shown in the UI, the Razorpay
 * order amount, and the GST recorded for the digest — and they must agree
 * exactly. Computing them in more than one place is how a customer gets shown
 * one price and charged another.
 */

/**
 * How many tokens a bundle contains. Configurable from BMS, because it is the
 * lever that changes the effective price of a connection without touching what
 * the customer is charged or the GST that follows from it — the amount stays
 * ₹472 / $5.00 and only the tokens move.
 */
export const DEFAULT_TOKENS_PER_BUNDLE = 25;

/**
 * The only values BMS may set. A free-text number would let a typo ship 2500
 * tokens for ₹472, so the set is closed and enforced server-side rather than
 * trusted from the admin UI.
 */
export const ALLOWED_BUNDLE_SIZES = [25, 50, 75, 100] as const;
export type BundleSize = (typeof ALLOWED_BUNDLE_SIZES)[number];

export function isAllowedBundleSize(n: unknown): n is BundleSize {
  return typeof n === 'number' && (ALLOWED_BUNDLE_SIZES as readonly number[]).includes(n);
}

/** Falls back to the default rather than throwing: a bad stored value must not take pricing down. */
export function coerceBundleSize(n: unknown): BundleSize {
  return isAllowedBundleSize(n) ? n : DEFAULT_TOKENS_PER_BUNDLE;
}

/** Percent, applied to the base amount for Indian customers. */
export const GST_RATE = 18;

export interface BundlePrice {
  /** ISO 4217. */
  currency: 'INR' | 'USD';
  /** Currency symbol for display. */
  symbol: string;
  tokens: number;
  /** All amounts in ATOMIC units — paise or cents. Never floats. */
  baseMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Human label for the tax line, or null when no tax applies. */
  taxLabel: string | null;
}

/**
 * Money is held in minor units end to end. Rupees or dollars as floats would
 * accumulate representation error, and Razorpay takes paise and cents anyway,
 * so converting once at the edge for display is the only rounding that happens.
 */
export function priceForCountry(country: string, tokensPerBundle: unknown = DEFAULT_TOKENS_PER_BUNDLE): BundlePrice {
  const cc = String(country ?? '').trim().toUpperCase();
  const tokens = coerceBundleSize(tokensPerBundle);

  if (cc === 'IN') {
    const baseMinor = 40000; // ₹400.00
    const taxMinor = Math.round((baseMinor * GST_RATE) / 100); // ₹72.00
    return {
      currency: 'INR',
      symbol: '₹',
      tokens,
      baseMinor,
      taxMinor,
      totalMinor: baseMinor + taxMinor, // ₹472.00
      taxLabel: `GST at ${GST_RATE}%`,
    };
  }

  // Everywhere else: flat, no regional tax collected by us.
  const baseMinor = 500; // $5.00
  return {
    currency: 'USD',
    symbol: '$',
    tokens,
    baseMinor,
    taxMinor: 0,
    totalMinor: baseMinor,
    taxLabel: null,
  };
}

/** Minor units to a display string, e.g. 47200 -> "₹472.00". */
export function formatMinor(minor: number, symbol: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}


/**
 * Which Razorpay credentials the billing integration uses.
 *
 * The two modes are entirely separate Razorpay environments with their own
 * key pairs and their own webhook signing secrets — a test order cannot be
 * settled with live keys, and a live webhook will not verify against a test
 * secret. So switching mode has to switch the whole credential set together,
 * which is why this names a secret rather than a flag.
 */
export const PAYMENT_MODES = ['test', 'live'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const DEFAULT_PAYMENT_MODE: PaymentMode = 'test';

export function isPaymentMode(v: unknown): v is PaymentMode {
  return typeof v === 'string' && (PAYMENT_MODES as readonly string[]).includes(v);
}

/**
 * Anything unrecognised resolves to test. A corrupted or missing setting must
 * never fall through to charging real cards — the safe default is the one that
 * cannot take money.
 */
export function coercePaymentMode(v: unknown): PaymentMode {
  return isPaymentMode(v) ? v : DEFAULT_PAYMENT_MODE;
}

/** Razorpay credentials are shared with CloudMeter; test and live live apart. */
export const RAZORPAY_SECRET_BY_MODE: Record<PaymentMode, string> = {
  test: 'cloudmeter/razorpay_dev',
  live: 'cloudmeter/razorpay_prod',
};
