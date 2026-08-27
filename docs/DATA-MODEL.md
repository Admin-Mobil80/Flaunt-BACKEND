# Flaunt — DynamoDB Single-Table Design

Draft of the data layer for the PRD (network graph, front-loaded token economy,
triadic introductions, Razorpay billing, BMS admin/digests).

This document is **infrastructure-agnostic** — the key schema, access patterns and
stream semantics below are the same whether the table is declared in SAM or CDK.

Deviations from the PRD's entity matrix are called out inline as **[Δ]**, each with a
reason. Open risks are called out as **[!]**.

---

## 1. Access patterns

The design is driven by this list. Anything not on it is not supported without a new index.

| # | Access pattern | Where it comes from | How it's served |
|---|---|---|---|
| A1 | Get my profile / any profile by userId | everywhere | `GetItem PK=USER#<id>, SK=METADATA` |
| A2 | Resolve an email → userId (login, invite targeting, dedupe) | §3.1, §3.4 | `GetItem PK=EMAIL#<email>, SK=UNIQUE` |
| A3 | Claim an email so nobody else can (primary + secondary) | §3.1 | Conditional put on the same item as A2 |
| A4 | List my 1st-degree connections | §3.2 | `Query PK=USER#<id>, SK begins_with CONNECTION#` |
| A5 | Compute 2nd-degree set + find the gatekeeper(s) for A→C | §3.2, §3.5 | Fan-out over A4 (see §5) |
| A6 | Search users by name (3rd degree and beyond) | §3.2 | GSI3, `NAME#` namespace — **prefix only** |
| A6b | Show designation on a search hit / masked profile | §3.2 + this change | GSI3 `INCLUDE` projection |
| A7 | List invitations I sent (outbox) | §3.4 | GSI1 `USER#<senderId>` |
| A8 | List invitations addressed to me (inbox) | §3.4 | GSI2 `EMAIL#<recipientEmail>` |
| A9 | Get one invitation by id (accept / reject / gatekeeper link) | §3.4, §3.5 | `GetItem PK=INVITE#<id>, SK=METADATA` |
| A10 | Adjust a token balance atomically | §3.3, §3.4, §5 NFR | `UpdateItem` `ADD tokenBalance` + condition |
| A11 | Read a user's token ledger history | §4.2 | `Query PK=USER#<id>, SK begins_with TXN#` |
| A12 | Record + dedupe a Razorpay webhook delivery | §3.3 | `PK=WEBHOOK#<eventId>` conditional put |
| A13 | Admin: all invitations filtered by state | §4.2 | GSI3, `INVITE_STATUS#` namespace |
| A14 | Admin: recent webhook event trail | §4.2 | GSI3, `WEBHOOK_DAY#` namespace |
| A15 | Admin: all users + balances + country + age | §4.2 | GSI3, `USER_DIR#` namespace |
| A16 | Daily digest counters (signups by country, refunds, revenue) | §4.3 | Pre-aggregated `STATS#` counters (see §7) |

---

## 2. Table & index configuration

Base table — `PK` (S, HASH) / `SK` (S, RANGE), on-demand billing, PITR on, SSE on,
`StreamViewType: NEW_AND_OLD_IMAGES`, TTL attribute `expiresAt` (epoch **seconds**).

Three global secondary indexes:

| Index | Partition key | Sort key | Projection | Serves |
|---|---|---|---|---|
| `GSI1` | `GSI1PK` | `GSI1SK` | `ALL` | A7 |
| `GSI2` | `GSI2PK` | `GSI2SK` | `ALL` | A8 |
| `GSI3` | `GSI3PK` | `GSI3SK` | `INCLUDE` (see below) | A6, A13, A14, A15 |

**[Δ] Attribute names are `GSI1PK`/`GSI1SK`, not the PRD's `GSI1-PK`/`GSI1-SK`.**
Hyphens are legal in DynamoDB attribute names but illegal in expression syntax, so every
single query would need an `ExpressionAttributeNames` alias. The existing deployed table
already uses the unhyphenated form.

**[Δ] Three indexes, not one.** The PRD's single GSI1 cannot serve A8, A13, A14 or A15 —
an item has exactly one `GSI1PK` value, and the PRD spends it on the sender outbox (A7),
which leaves a recipient with no way to list invitations addressed to them. That is a
required flow (§3.4: "if the recipient logs in and accepts"), so it needs its own index.

**GSI3 is a deliberately multi-namespace sparse index.** Different entity types write
different `GSI3PK` prefixes (`NAME#`, `INVITE_STATUS#`, `WEBHOOK_DAY#`, `USER_DIR#`) and no
item is in more than one namespace, so one index covers four admin/search patterns instead
of four indexes. Project `INCLUDE` with only the columns the BMS tables render
(`name`, `country`, `tokenBalance`, `createdAt`, `status`, `entityType`) — an `ALL`
projection here would double write cost on every user and invitation for admin-only reads.

Every item carries an `entityType` attribute (`USER`, `CONNECTION`, `INVITE`, …) so stream
consumers can route without parsing keys.

---

## 3. Entity layout

### 3.1 User profile
```
PK    USER#<userId>
SK    METADATA
GSI3PK NAME#<first char of normalizedName>      GSI3SK <normalizedName>#<userId>
attrs  name, normalizedName, designation, organisation, location, bio, profilePicUrl,
       country, tokenBalance, primaryEmail, secondaryEmail, createdAt, entityType=USER
```
`normalizedName` is lowercased, accent-folded, whitespace-collapsed.

**`designation` (required), `organisation` (optional) and `location` (optional)** are
display attributes on the profile item. None is a key or an index member, so none costs
a table change — DynamoDB has no schema for non-key attributes, and adding them to new
writes is free.

`organisation` is held apart from `designation` rather than folded into one line, so the
employer can be displayed, and later filtered, on its own. It is **free text by
decision**: no company registry, no canonical list, no matching against one. The accepted
consequence is that "Ather Energy" and "Ather Energy Pvt Ltd" are two different employers
as far as the data is concerned, and any future "everyone at X" query will under-count
until something canonicalises them.

**[!] `location` is not `country`, and neither may be derived from the other.**
`country` is ISO alpha-2, captured once at signup, and is the authoritative input to
the tax calculation in §3.3. `location` is free display text the user writes for
themselves. They are permitted to disagree: an account whose `country` is `IN` is
charged 18% GST whether its `location` reads "Bengaluru", "Dubai" or nothing.
Inferring pricing from `location`, or pre-filling `country` from it, is a billing bug.

`designation` is the title alone ("Design director"); the employer belongs in
`organisation`.

**[Δ] `bio` lives here only — not as a Cognito `custom:` attribute.** Cognito caps custom
attributes at 2048 characters; 300 words of ordinary English is ~1800 characters and
routinely exceeds 2048 with longer words, so a conforming bio can be rejected by Cognito.
`custom:country` stays in Cognito (short, and needed by the pre-token-generation flow).

**[Δ] `tokenBalance` is on the profile item, and is the only mutable copy.** It is never
mirrored into Cognito or a GSI-projected duplicate — a second copy cannot be kept
consistent with an atomic `ADD`.

### 3.2 Email ownership (primary + secondary)
```
PK    EMAIL#<lowercased email>
SK    UNIQUE
attrs userId, kind = PRIMARY | SECONDARY, verified, createdAt, entityType=EMAIL
```
**[Δ] Email lookup is a base-table item, not the profile's GSI1 entry.** Two reasons:
a GSI read is eventually consistent, so a GSI-based uniqueness check races with itself and
lets two accounts claim the same address; and a conditional `attribute_not_exists(PK)` put
only works against the base table. Making this its own item gives strongly-consistent
`GetItem` lookups *and* real uniqueness enforcement, and it handles secondary emails —
which the PRD's matrix has no lookup path for at all.

### 3.3 Connection (mirrored pair)
```
PK    USER#<userId>          SK  CONNECTION#<otherUserId>
attrs otherUserId, relationshipDegree = 1, connectedAt, entityType=CONNECTION
```
**[Δ] Two mirrored items per connection, written in one `TransactWriteItems`; connections
are not in any GSI.** The PRD stores one item and reaches the other direction via GSI1.
That makes "list C's connections" an eventually-consistent GSI query, and the 2nd-degree
fan-out (A5) issues one such query per 1st-degree contact — so a connection accepted
moments ago can be invisible to the very graph walk that gates introductions. Mirrored
base-table items make every direction a strongly-consistent `Query`, and free GSI1 for the
outbox. Cost is identical: two writes either way (item + index entry vs. two items).

`relationshipDegree` is stored as a constant `1`. Degree 2 is **computed at read time**
(§5) and never persisted — persisting it would require rewriting O(n²) rows on every new
connection.

### 3.4 Invitation
```
PK    INVITE#<inviteId>       SK  METADATA
GSI1PK USER#<senderId>        GSI1SK INVITE#<createdAt>#<inviteId>     (outbox)
GSI2PK EMAIL#<recipientEmail> GSI2SK <status>#<createdAt>              (inbox)
GSI3PK INVITE_STATUS#<status> GSI3SK <createdAt>#<inviteId>            (admin)
attrs  senderId, recipientEmail, recipientUserId?, status, type = DIRECT | INTRO,
       gatekeeperId?, targetUserId?, createdAt, expiresAt (TTL, epoch seconds),
       tokenCharged = true, entityType=INVITE
```
`status` ∈ `PENDING`, `PENDING_GATEKEEPER`, `INTRO_PENDING`, `ACCEPTED`, `REJECTED`,
`GATEKEEPER_DENIED`, `EXPIRED`.

Because `status` is part of `GSI2SK` and `GSI3PK`, every status transition rewrites those
index entries — that is intended, and it is what makes "pending invites for this email"
and "all REJECTED invites" single queries.

### 3.5 Terminal archive (expired invitations)
```
PK    INVITE#<inviteId>       SK  ARCHIVE
attrs status = EXPIRED, senderId, recipientEmail, createdAt, expiredAt, entityType=INVITE_ARCHIVE
```
**[!] The PRD says the TTL stream handler "marks the master invite tracking index as
EXPIRED" — but TTL *deletes* the row, so there is nothing left to mark.** The stream
handler writes this archive item (no TTL on it) so the BMS console and the digest keep
their history.

### 3.6 Token ledger entry
```
PK    USER#<userId>           SK  TXN#<ISO-8601 timestamp>#<uuid>
attrs delta, reason (SIGNUP_GRANT | INVITE_SENT | REFUND_REJECTED | REFUND_EXPIRED |
      REFUND_GATEKEEPER_DENIED | PURCHASE | ADMIN_OVERRIDE), balanceAfter,
      relatedId, actorId, entityType=TXN
```
**[Δ] The sort key carries a uuid suffix.** The PRD's `TRANSACTION#<Timestamp>` collides
whenever two ledger entries land in the same millisecond, and a colliding put silently
overwrites the earlier entry — in a ledger that is data loss.

### 3.7 Payment order + webhook receipt
```
PK    PAYMENT#<razorpayOrderId>   SK  METADATA
attrs userId, currency (INR|USD), baseAmount, taxAmount, totalAmount, tokens = 25,
      status, createdAt, entityType=PAYMENT

PK    WEBHOOK#<razorpayEventId>   SK  METADATA
GSI3PK WEBHOOK_DAY#<YYYY-MM-DD>   GSI3SK <receivedAt>#<eventId>
attrs  eventType, signatureValid, orderId, rawPayloadS3Key, receivedAt,
       expiresAt (TTL, 90d), entityType=WEBHOOK
```
Amounts are stored in **atomic units** (paise / cents) as integers — never floats.

### 3.8 User directory row (BMS)
The profile item additionally carries `GSI3PK = USER_DIR#<country>`,
`GSI3SK = <createdAt>#<userId>` … **[!] conflict:** an item cannot hold two `GSI3PK`
values, and §3.1 already spends the profile's GSI3 slot on name search. Resolved by
writing a **separate thin directory item**:
```
PK    USER#<userId>           SK  DIRECTORY
GSI3PK USER_DIR#<country>     GSI3SK <createdAt>#<userId>
attrs  name, country, createdAt, entityType=USER_DIRECTORY
```
kept in sync in the same transaction as the profile. It holds no `tokenBalance` — the BMS
ledger table reads balances via A1 per row, or from the §7 counters in aggregate.

### 3.9 Where designation and location sit in the visibility tiers

§3.2 of the PRD grades what each tier may see. The two new attributes need placing on
that grid, and they do not land in the same place:

| Attribute | 1st degree | 2nd degree | 3rd / name search |
|---|---|---|---|
| Name, description, photo | visible | visible | visible |
| `designation` | visible | visible | **visible** |
| `organisation` | visible | visible | **visible** |
| `location` | visible | visible | **withheld** |
| Primary / secondary email | visible | masked | withheld |

**`designation` and `organisation` are visible at every tier, including search.** Together
they are what makes the tier system work at all: a search result showing only a name gives
a user nothing to judge before spending a token on an introduction, and the whole economy
depends on that judgement being possible.

The line drawn here is professional identity versus personal geography. Title and employer
are the facts a person publishes in order to be found for professional reasons, so they
travel to the outermost tier. Where someone physically is does not serve that purpose and
narrows them considerably, so it does not.

**`location` stops at 2nd degree.** Name plus title plus city is a materially stronger
re-identification handle for a stranger than name plus title, and the PRD's privacy
posture is that each tier reveals strictly more than the one outside it. Withholding it
costs a searcher little, since `country` is not exposed at any tier either.

Both rules are enforced in the same AppSync response mapping that masks email (§3.2) —
never client-side, and any Lambda that returns a profile applies the identical filter.

---

## 4. Token safety (§5 "Race Condition Mitigation")

**[Δ] `attribute_exists(PK)` alone is not sufficient** — it proves the user row exists but
permits the balance going negative under concurrency, which is exactly the parallel-queuing
attack §3.4 wants to prevent. Every debit uses:

```
UpdateExpression:    ADD tokenBalance :neg
ConditionExpression: attribute_exists(PK) AND tokenBalance >= :one
```

and the debit + the invitation creation + the ledger entry go in **one
`TransactWriteItems`**, so a token can never be spent without the invite that justifies it.

Refunds must be **idempotent**, because DynamoDB Streams deliver at least once and a
retried batch would otherwise refund twice. Each refund transaction contains:

1. `Put` `PK=INVITE#<id>, SK=REFUND` with `ConditionExpression: attribute_not_exists(PK)`
2. `Update` `ADD tokenBalance :one` on the sender
3. `Put` the ledger entry

If the refund marker already exists the whole transaction is rejected and nothing moves.

---

## 5. Degree-2 resolution and the gatekeeper lookup

```
S1 = Query(USER#A, begins_with CONNECTION#)              -> 1 query
for each b in S1: Query(USER#b, begins_with CONNECTION#) -> |S1| queries
S2 = union(results) - S1 - {A}
gatekeepers(A -> C) = { b in S1 : C in connections(b) }
```

**[!] This is `1 + |S1|` queries per profile view, and it is the hot path for both §3.2
visibility and §3.5 introductions.** It is fine at MVP scale and becomes the first thing to
break at ~500+ connections per user. Mitigations, in the order I would apply them:

1. Cap the fan-out (query at most N 1st-degree contacts, newest first) — changes results.
2. Cache `connections(userId)` in the resolver Lambda / DAX, invalidated on new connection.
3. Only compute the *gatekeeper* on demand (A→C intersection), not the full S2 set — a
   masked profile page needs one gatekeeper, not the entire 2nd-degree universe.

I'd build (3) from the start: it turns the introduction flow into 2 queries regardless of
network size, and reserve the full S2 walk for an explicit "browse 2nd degree" screen.

---

## 6. TTL, expiry and the refund stream

**[!] Three correctness problems with the PRD's TTL design, and their fixes:**

1. **TTL deletes non-pending invitations too.** An `ACCEPTED` invite still carries
   `expiresAt`, so it is deleted on day 7 and fires the same `REMOVE` event — refunding a
   token that §3.4 says must stay consumed. *Fix:* `REMOVE expiresAt` from the item as part
   of every terminal transition, so only genuinely-pending invitations can ever expire. The
   stream handler additionally re-checks `OLD_IMAGE.status` before refunding, as defence in
   depth, and ignores `REMOVE` events where `userIdentity.principalId != "dynamodb.amazonaws.com"`
   (those are ordinary deletes, not TTL expiry).

2. **TTL is not punctual.** DynamoDB typically deletes within 48 hours of the timestamp,
   not at it. So the deletion cannot be what enforces the 7-day window. *Fix:* `expiresAt`
   is authoritative at read time — the accept mutation rejects any invite where
   `now > expiresAt` regardless of whether the row still exists. TTL is only the
   *cleanup and refund* trigger. If the refund must land punctually at day 7, that needs
   EventBridge Scheduler (one schedule per invite), not TTL.

3. **The record is gone, so the state is unauditable.** Handled by §3.5's archive item.

Stream configuration: `NEW_AND_OLD_IMAGES`, filtered to `REMOVE` events on `INVITE#`
partitions, `BisectBatchOnFunctionError: true`, `MaximumRetryAttempts` bounded, and an
on-failure destination SQS queue — the existing `flaunt-queue-dlq` is a fit. A refund lost
to a poison batch is a silent debit against a real user, so this queue needs an alarm.

---

## 7. Digest counters (§4.3)

**[!] The digest must not `Scan`.** "Total users by country", "refunds issued", "gross
revenue by currency" are unbounded aggregates; a nightly full-table scan gets slower and
more expensive every day it runs.

Counters are incremented with `ADD` inside the same transaction as the event they count:
```
PK STATS#GLOBAL             SK DAY#<YYYY-MM-DD>
PK STATS#COUNTRY#<cc>       SK DAY#<YYYY-MM-DD>
attrs signups, invitesSent, invitesAccepted, invitesRejected, invitesExpired,
      tokensRefunded, tokensPurchased, revenueMinorInr, gstMinorInr, revenueMinorUsd
```
The 00:00 UTC Lambda then reads a bounded set of counter rows (one global + one per active
country) instead of the whole table, and `STATS#GLOBAL / DAY#…` rows double as the BMS
dashboard's time series.

---

## 8. Open items

- **Table name.** The PRD says `Flaunt_Core_Production`; the deployed template says
  `flaunt-table`. Renaming a table in CloudFormation **replaces** it — the old table and
  everything in it is deleted. Safe only if nothing real is in it yet.
- **Name search is prefix-only** (A6). `begins_with` on `normalizedName` cannot match a
  middle-of-string query, and bucketing by first letter gives ~26 partitions, so a common
  initial is a warm partition. Real search means OpenSearch Serverless fed from the stream.
- **Neither designation nor organisation is searchable.** A6b displays them; they are not
  indexed, so "everyone who is a founder" and "everyone at Razorpay" are not supported
  queries. Either needs a fourth GSI on a normalized value, or the OpenSearch path below.
  Free-text organisation makes the second harder: without canonicalisation the index
  splits one employer across every spelling of its name.
- **PRD §5 needs updating.** Data minimization currently permits "name, description,
  country, profile photo, and emails" and nothing else. Designation and location are two
  new categories of personal data; the clause and the system now disagree, and the clause
  is what a privacy review would be held to.
- **The mask leaks.** `riy**@mo******.com` exposes 3 characters of local part, 2 of domain
  and the full TLD; next to a full name and a company-shaped domain that is often enough to
  reconstruct the address. If the intent is that 2nd-degree contacts genuinely cannot mail
  the user, the domain should be masked entirely (`riy***@***.com`) or dropped.
- **Masking must be server-side only.** Correct in the PRD (§3.2) — worth restating that it
  belongs in the resolver's response mapping, never in the frontend, and that any Lambda
  returning a raw profile must apply the same filter.
