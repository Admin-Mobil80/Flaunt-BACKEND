/**
 * Server-side profile validation. The frontend enforces the same limits for UX,
 * but this is the copy that is authoritative — §3.1 of the PRD requires the
 * 300-word bio cap to hold at the backend regardless of what the client sent.
 */

export const BIO_MAX_WORDS = 300;

/**
 * A byte ceiling as well as a word ceiling. Two things set it.
 *
 * Shape: 300 "words" of 400 characters each is a 120KB profile item — under
 * DynamoDB's 400KB limit, so the write would succeed, but it is not a
 * professional bio.
 *
 * The actual number is Cognito's. The bio reaches the backend as a custom
 * attribute at sign-up, and 2048 characters is the hard ceiling for one.
 *
 * **[!] 2048 bytes does not reliably hold 300 words**, and it is worth being
 * precise about that rather than assuming it does. Including the separating
 * space, 300 words fit only if they average under ~5.8 characters. Everyday
 * prose (~4.7) fits with room; a bio written in the vocabulary this product
 * attracts — "infrastructure", "reconciliation", "responsibilities" — can run
 * 6–7 and be rejected while comfortably under 300 words. The practical ceiling
 * today is nearer 250–290 words depending on vocabulary, which is short of what
 * §3.1 promises.
 *
 * This is a constraint of routing the bio through a sign-up attribute, not a
 * product decision. It lifts when profile writes go through the API and the bio
 * goes straight to DynamoDB, where the only real limit is the 400KB item.
 */
export const BIO_MAX_BYTES = 2048;

export const NAME_MAX_CHARS = 120;

/**
 * Job title, on its own — "Design director". Required, because it is what makes
 * a masked 2nd-degree profile worth acting on: a searcher who can see only a
 * name has nothing to judge before spending a token on an introduction.
 *
 * Free text rather than a controlled vocabulary: job titles do not fit one, and
 * a dropdown would be wrong for most of the world's roles.
 */
export const DESIGNATION_MAX_CHARS = 100;

/**
 * Employer, held separately from the title so each can be displayed, and later
 * filtered, on its own. Free text by decision — no company registry, no
 * canonical list, no matching against one.
 *
 * Optional: founders between things, people between jobs, and anyone who would
 * rather not name their employer all have valid profiles without it.
 */
export const ORGANISATION_MAX_CHARS = 100;

/**
 * Where the person is, as they would say it ("Bengaluru, India"). Optional.
 *
 * This is a DISPLAY string and nothing else. It is never parsed, never
 * geocoded, and — critically — never used to decide anything commercial. The
 * `country` attribute is the authoritative field for tax and pricing (§3.3),
 * it is set once at signup from an ISO alpha-2 code, and the two are allowed
 * to disagree: someone whose country is IN pays 18% GST whether their location
 * reads "Bengaluru", "Dubai" or nothing at all. Deriving one from the other in
 * either direction is a billing bug.
 */
export const LOCATION_MAX_CHARS = 80;

export class ValidationError extends Error {
  public readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export function countWords(text: string): number {
  const trimmed = String(text).trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

export function validateBio(bio: unknown): string {
  if (typeof bio !== 'string' || bio.trim() === '') {
    throw new ValidationError('bio', 'Professional description is required.');
  }
  const words = countWords(bio);
  if (words > BIO_MAX_WORDS) {
    throw new ValidationError(
      'bio',
      `Professional description must be ${BIO_MAX_WORDS} words or fewer (got ${words}).`
    );
  }
  const bytes = Buffer.byteLength(bio, 'utf8');
  if (bytes > BIO_MAX_BYTES) {
    throw new ValidationError(
      'bio',
      `Professional description must be ${BIO_MAX_BYTES} bytes or fewer (got ${bytes}).`
    );
  }
  return bio.trim();
}

export function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ValidationError('name', 'Full name is required.');
  }
  const trimmed = name.trim();
  if (trimmed.length > NAME_MAX_CHARS) {
    throw new ValidationError('name', `Full name must be ${NAME_MAX_CHARS} characters or fewer.`);
  }
  return trimmed;
}

export function validateDesignation(designation: unknown): string {
  if (typeof designation !== 'string' || designation.trim() === '') {
    throw new ValidationError('designation', 'Designation is required.');
  }
  const trimmed = designation.trim().replace(/\s+/g, ' ');
  if (trimmed.length > DESIGNATION_MAX_CHARS) {
    throw new ValidationError(
      'designation',
      `Designation must be ${DESIGNATION_MAX_CHARS} characters or fewer (got ${trimmed.length}).`
    );
  }
  return trimmed;
}

/**
 * Optional second address. Shape-checked only — it is NOT proved to belong to
 * the person entering it, so it is stored as a claim and shown as unverified.
 *
 * Deliberately does not claim the address in the EMAIL# uniqueness space: doing
 * so would let anyone squat an address they do not control and block its real
 * owner from ever signing up. Ownership is only recorded once a verification
 * round-trip exists.
 */
export function validateSecondaryEmail(email: unknown): string | undefined {
  if (email === undefined || email === null || String(email).trim() === '') return undefined;
  const v = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || v.length > 254) {
    throw new ValidationError('secondaryEmail', 'That does not look like an email address.');
  }
  return v;
}

/** Optional: an omitted or blank organisation is valid and stored as undefined. */
export function validateOrganisation(organisation: unknown): string | undefined {
  if (organisation === undefined || organisation === null || String(organisation).trim() === '') {
    return undefined;
  }
  if (typeof organisation !== 'string') {
    throw new ValidationError('organisation', 'Organisation must be text.');
  }
  const trimmed = organisation.trim().replace(/\s+/g, ' ');
  if (trimmed.length > ORGANISATION_MAX_CHARS) {
    throw new ValidationError(
      'organisation',
      `Organisation must be ${ORGANISATION_MAX_CHARS} characters or fewer (got ${trimmed.length}).`
    );
  }
  return trimmed;
}

/** Optional: an omitted or blank location is valid and stored as undefined. */
export function validateLocation(location: unknown): string | undefined {
  if (location === undefined || location === null || String(location).trim() === '') {
    return undefined;
  }
  if (typeof location !== 'string') {
    throw new ValidationError('location', 'Location must be text.');
  }
  const trimmed = location.trim().replace(/\s+/g, ' ');
  if (trimmed.length > LOCATION_MAX_CHARS) {
    throw new ValidationError(
      'location',
      `Location must be ${LOCATION_MAX_CHARS} characters or fewer (got ${trimmed.length}).`
    );
  }
  return trimmed;
}

/**
 * ISO 3166-1 alpha-2. Validated as a shape here; the authoritative list lives in
 * the shared country table the signup dropdown is built from. Country drives
 * pricing (§3.3), so a bad value here is a billing bug, not a cosmetic one.
 */
export function validateCountry(country: unknown): string {
  if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country.trim())) {
    throw new ValidationError('country', 'Country must be a 2-letter ISO 3166-1 alpha-2 code.');
  }
  return country.trim().toUpperCase();
}
