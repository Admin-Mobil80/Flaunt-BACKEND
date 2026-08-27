import * as keys from '../functions/shared/keys';
import { validateBio, validateCountry, validateDesignation, validateLocation,
  validateOrganisation, countWords, ValidationError } from '../functions/shared/validation';

describe('key builders', () => {
  // Two casings of one address must not become two accounts.
  test('email keys are case- and whitespace-insensitive', () => {
    expect(keys.emailOwnership('  RiYaD@Mobil80.COM ')).toEqual({
      PK: 'EMAIL#riyad@mobil80.com',
      SK: 'UNIQUE',
    });
  });

  test('name search folds accents so "Sahin" finds "Şahin"', () => {
    expect(keys.gsi3NameSearch('Ünal  Şahin', 'u9')).toEqual({
      GSI3PK: 'NAME#u',
      GSI3SK: 'unal sahin#u9',
    });
  });

  test('non-alphabetic names land in the # bucket rather than a stray partition', () => {
    expect(keys.nameBucket('声優')).toBe('#');
  });

  // Status leads the inbox sort key so "my pending invites" is a begins_with.
  test('inbox sort key is status-prefixed', () => {
    expect(keys.gsi2Inbox('A@B.com', keys.INVITE_STATUS.PENDING, '2026-08-27T10:00:00.000Z')).toEqual({
      GSI2PK: 'EMAIL#a@b.com',
      GSI2SK: 'PENDING#2026-08-27T10:00:00.000Z',
    });
  });

  // Ledger entries in the same millisecond must not overwrite each other.
  test('ledger sort keys are unique under collision', () => {
    const t = '2026-08-27T10:00:00.000Z';
    expect(keys.transaction('u1', t).SK).not.toEqual(keys.transaction('u1', t).SK);
  });

  test('TTL is epoch seconds, seven days out', () => {
    const from = new Date('2026-08-27T00:00:00Z');
    const ttl = keys.inviteExpiryEpochSeconds(from);
    expect(ttl).toBe(Math.floor(from.getTime() / 1000) + 7 * 86400);
    // A milliseconds value would be ~1000x larger and expire in the year 50,000.
    expect(ttl).toBeLessThan(2_000_000_000);
  });

  test('expiry is decided by the timestamp, not by the row still existing', () => {
    const from = new Date('2026-08-27T00:00:00Z');
    const ttl = keys.inviteExpiryEpochSeconds(from);
    expect(keys.isExpired(ttl, new Date('2026-09-04T00:00:00Z'))).toBe(true);
    expect(keys.isExpired(ttl, new Date('2026-08-30T00:00:00Z'))).toBe(false);
  });

  test('only ACCEPTED keeps the token', () => {
    expect(keys.TERMINAL_KEEPS_TOKEN).toEqual(['ACCEPTED']);
    expect(keys.TERMINAL_REFUNDS_TOKEN).toEqual(
      expect.arrayContaining(['REJECTED', 'GATEKEEPER_DENIED', 'EXPIRED'])
    );
  });
});

describe('bio validation (§3.1: 300 words, enforced backend-side)', () => {
  const words = (n: number) => 'word '.repeat(n).trim();

  test('accepts exactly 300 words', () => {
    expect(countWords(words(300))).toBe(300);
    expect(validateBio(words(300))).toHaveLength(words(300).length);
  });

  test('rejects 301', () => {
    expect(() => validateBio(words(301))).toThrow(ValidationError);
  });

  test('counts words by whitespace runs, not spaces', () => {
    expect(countWords('one\n\ttwo   three')).toBe(3);
  });

  test('rejects a blank or missing bio', () => {
    expect(() => validateBio('   \n ')).toThrow(/required/);
    expect(() => validateBio(undefined)).toThrow(/required/);
  });

  // 300 "words" can still be a huge item without a byte ceiling.
  test('rejects few-but-enormous words', () => {
    expect(() => validateBio('x'.repeat(3000))).toThrow(/bytes/);
  });

  // The cap is Cognito's 2048-char custom-attribute ceiling. These two tests
  // pin where it actually bites, because it does NOT reliably hold 300 words.
  test('300 everyday-length words fit inside the byte cap', () => {
    const prose = Array.from({ length: 300 }, () => 'teams').join(' '); // 5+1 chars
    expect(countWords(prose)).toBe(300);
    expect(validateBio(prose)).toBeTruthy();
  });

  // A bio well under 300 words is still rejected once the vocabulary is long —
  // the gap between what §3.1 promises and what a sign-up attribute can carry.
  test('300 long words are rejected on bytes despite being within the word limit', () => {
    const dense = Array.from({ length: 300 }, () => 'infrastructure').join(' ');
    expect(countWords(dense)).toBe(300);
    expect(() => validateBio(dense)).toThrow(/bytes/);
  });
});

describe('country validation (drives pricing, §3.3)', () => {
  test('normalizes to uppercase alpha-2', () => {
    expect(validateCountry(' in ')).toBe('IN');
  });

  test('rejects alpha-3 and junk', () => {
    expect(() => validateCountry('IND')).toThrow(ValidationError);
    expect(() => validateCountry('')).toThrow(ValidationError);
  });
});

describe('designation (required — it is what a masked profile is judged on)', () => {
  test('collapses inner whitespace and trims', () => {
    expect(validateDesignation('  Design   director,  Ather Energy ')).toBe('Design director, Ather Energy');
  });

  test('rejects blank or missing', () => {
    expect(() => validateDesignation('   ')).toThrow(/required/);
    expect(() => validateDesignation(undefined)).toThrow(ValidationError);
  });

  test('rejects over 100 characters', () => {
    expect(() => validateDesignation('x'.repeat(101))).toThrow(/100 characters/);
    expect(validateDesignation('x'.repeat(100))).toHaveLength(100);
  });
});

describe('location (optional, display-only)', () => {
  test('accepts and normalizes', () => {
    expect(validateLocation(' Bengaluru,   India ')).toBe('Bengaluru, India');
  });

  // Optional means an absent value is valid, not an error and not an empty string.
  test('blank, null and undefined all mean "not provided"', () => {
    expect(validateLocation('')).toBeUndefined();
    expect(validateLocation('   ')).toBeUndefined();
    expect(validateLocation(null)).toBeUndefined();
    expect(validateLocation(undefined)).toBeUndefined();
  });

  test('rejects over 80 characters', () => {
    expect(() => validateLocation('x'.repeat(81))).toThrow(/80 characters/);
  });

  // Location is display text; country is the billing fact. A user in Dubai whose
  // account country is IN still pays GST, and neither field may be inferred from
  // the other — this test exists to pin that they are independent.
  test('does not influence country, and vice versa', () => {
    expect(validateLocation('Dubai, UAE')).toBe('Dubai, UAE');
    expect(validateCountry('IN')).toBe('IN');
  });
});

describe('organisation (optional, free text by decision)', () => {
  test('normalizes whitespace', () => {
    expect(validateOrganisation('  Ather   Energy ')).toBe('Ather Energy');
  });

  test('blank, null and undefined all mean "not provided"', () => {
    expect(validateOrganisation('')).toBeUndefined();
    expect(validateOrganisation('   ')).toBeUndefined();
    expect(validateOrganisation(null)).toBeUndefined();
    expect(validateOrganisation(undefined)).toBeUndefined();
  });

  test('rejects over 100 characters', () => {
    expect(() => validateOrganisation('x'.repeat(101))).toThrow(/100 characters/);
  });

  // Free text means no canonicalisation: two spellings of one employer are two
  // distinct strings, which is the accepted cost of not running a company registry.
  test('does not canonicalise — spellings stay distinct', () => {
    expect(validateOrganisation('Ather Energy')).not.toBe(validateOrganisation('Ather Energy Pvt Ltd'));
  });

  // A title is required; an employer is not. Someone between jobs still has a profile.
  test('a profile is valid with a designation and no organisation', () => {
    expect(validateDesignation('Independent consultant')).toBe('Independent consultant');
    expect(validateOrganisation(undefined)).toBeUndefined();
  });
});

import { priceForCountry, formatMinor, DEFAULT_TOKENS_PER_BUNDLE,
  ALLOWED_BUNDLE_SIZES, coerceBundleSize, isAllowedBundleSize } from '../functions/shared/pricing';

describe('token pricing (§3.3) — the UI and the Razorpay order must agree', () => {
  test('India: ₹400 + 18% GST = ₹472.00 for 25 tokens', () => {
    const p = priceForCountry('IN');
    expect(p).toMatchObject({ currency: 'INR', tokens: 25, baseMinor: 40000, taxMinor: 7200, totalMinor: 47200 });
    expect(formatMinor(p.totalMinor, p.symbol)).toBe('₹472.00');
    expect(formatMinor(p.taxMinor, p.symbol)).toBe('₹72.00');
  });

  test('outside India: flat $5.00, no tax line', () => {
    const p = priceForCountry('SG');
    expect(p).toMatchObject({ currency: 'USD', baseMinor: 500, taxMinor: 0, totalMinor: 500, taxLabel: null });
    expect(formatMinor(p.totalMinor, p.symbol)).toBe('$5.00');
  });

  test('country is matched case- and whitespace-insensitively', () => {
    expect(priceForCountry(' in ').totalMinor).toBe(47200);
    expect(priceForCountry('In').currency).toBe('INR');
  });

  // A missing country must not silently become the cheaper price.
  test('unknown or missing country falls back to the international price', () => {
    expect(priceForCountry('').currency).toBe('USD');
    expect(priceForCountry(undefined as any).currency).toBe('USD');
  });

  // Amounts stay in minor units precisely so this never becomes 472.00000000001.
  test('all amounts are integers in minor units', () => {
    for (const cc of ['IN', 'US', 'GB']) {
      const p = priceForCountry(cc);
      for (const v of [p.baseMinor, p.taxMinor, p.totalMinor]) expect(Number.isInteger(v)).toBe(true);
    }
  });

  test('bundle defaults to 25 when nothing is configured', () => {
    expect(DEFAULT_TOKENS_PER_BUNDLE).toBe(25);
    expect(priceForCountry('IN').tokens).toBe(25);
    expect(priceForCountry('US').tokens).toBe(25);
  });
});

describe('configurable bundle size (set from BMS)', () => {
  test('changes the tokens but never the amount charged or the GST', () => {
    for (const n of ALLOWED_BUNDLE_SIZES) {
      const inr = priceForCountry('IN', n);
      expect(inr.tokens).toBe(n);
      expect(inr.totalMinor).toBe(47200);
      expect(inr.taxMinor).toBe(7200);
      const usd = priceForCountry('US', n);
      expect(usd.tokens).toBe(n);
      expect(usd.totalMinor).toBe(500);
    }
  });

  test('accepts only 25, 50, 75, 100', () => {
    expect(ALLOWED_BUNDLE_SIZES).toEqual([25, 50, 75, 100]);
    for (const n of [25, 50, 75, 100]) expect(isAllowedBundleSize(n)).toBe(true);
    for (const n of [0, 1, 24, 26, 99, 2500, -25]) expect(isAllowedBundleSize(n)).toBe(false);
  });

  // A typo'd or corrupted stored value must not take pricing down, and must not
  // silently ship 2500 tokens for the price of 25.
  test('a bad stored value falls back to the default rather than being honoured', () => {
    expect(coerceBundleSize(2500)).toBe(25);
    expect(coerceBundleSize('50')).toBe(25);
    expect(coerceBundleSize(null)).toBe(25);
    expect(coerceBundleSize(undefined)).toBe(25);
    expect(priceForCountry('IN', 9999).tokens).toBe(25);
  });
});
