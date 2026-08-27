# Flaunt Backend

AWS CDK (TypeScript) infrastructure for **Flaunt** — a minimal, invitation-gated professional
network with a utility-token economy. Same toolchain and layout as the CloudMeter infra repo.

## Stacks

- **FlauntDataStack** — DynamoDB single-table store (users, connections, invitations, token
  ledger, payments, stats counters) + KMS key + profile-photo S3 bucket. **Built.**

Still to land, in dependency order — each takes `dataStack.table`:

- **FlauntAuthStack** — Cognito user pool, `custom:country`, and the PostConfirmation trigger
  that writes the profile and grants 10 tokens in one transaction (PRD §3.1).
- **FlauntAppSyncStack** — GraphQL API plus the pipeline resolver that masks email addresses on
  2nd-degree profiles before the payload leaves the API perimeter (§3.2).
- **FlauntInvitesStack** — invite/introduction mutations, the DynamoDB stream consumer, and the
  TTL refund handler (§3.4, §3.5).
- **FlauntBillingStack** — Razorpay order creation and the signature-verified webhook at
  `/webhooks/razorpay` (§3.3).
- **FlauntNotificationsStack** — SES identity and the invite / gatekeeper / digest emails.
- **FlauntAnalyticsStack** — EventBridge 00:00 UTC digest to riyad@mobil80.com (§4.3).
- **FlauntDnsStack / CertStack / FrontendStack** — `www.flaunt.network` and `bms.flaunt.network`
  (§4.1).

Every stack is instantiated once per environment (`dev`, `prod`) and named with a suffix —
`FlauntDataStackProd`. Resource names carry `_dev` / `_prod` so both environments can share one
AWS account, which is why the table is `Flaunt_Core_prod` rather than the PRD's literal
`Flaunt_Core_Production`.

## Data model

**[docs/DATA-MODEL.md](docs/DATA-MODEL.md) is the reference for the table** — the sixteen access
patterns, the entity layout, every deviation from the PRD's entity matrix with its reason, and
the token-safety and TTL-refund semantics. Read it before adding an index or a new entity type.

Three things in there are worth knowing before touching any of this:

1. **`attribute_exists(PK)` alone does not protect the token balance.** Every debit needs
   `AND tokenBalance >= :one`, or concurrent invites drive a user negative — the exact
   parallel-queuing attack §3.4 exists to prevent.
2. **DynamoDB TTL is not punctual** (deletes within ~48h of the timestamp, not at it) and it
   deletes accepted invitations too. `expiresAt` is re-checked at read time, terminal
   transitions strip the attribute, and refunds are made exactly-once by a conditional
   `INVITE#<id> / REFUND` marker inside the refund transaction.
3. **The nightly digest must not `Scan`.** Counters are incremented with `ADD` alongside the
   events they count; the digest reads a bounded set of `STATS#` rows.

## Commands

```bash
npm run build                    # type-check
npm test                         # jest — table config + key/validation invariants
npx cdk synth FlauntDataStackProd
npx cdk diff --all --profile <profile>
npx cdk deploy --all --profile <profile>
```

Deployment is manual for now — no CI/CD is wired to this repo. `cdk deploy` is run by hand
against the target AWS account/profile.

## Layout

```
bin/infra.ts            CDK app — instantiates every stack per environment
lib/                    one file per stack, plus env-config.ts
functions/shared/       code shared by Lambdas (key builders, validation)
graphql/schema.graphql  AppSync schema
docs/DATA-MODEL.md      single-table design reference
test/                   jest
```

## Migrated from SAM

This repo was AWS SAM (`template.yaml`) through its first commit. Nothing had been deployed, so
it was converted to CDK to match CloudMeter. The old template, its `samconfig.toml`, the health
handler and the SAM GitHub Actions workflow are preserved under [`legacy-sam/`](legacy-sam/) for
reference and are not part of the build — delete the folder once the CDK stacks cover everything
it provisioned.

`bootstrap/github-oidc.yaml` also predates the migration. It still creates the GitHub OIDC
provider and the three deploy roles, but the roles are scoped to SAM-style resource names; it
needs rewriting (as a CDK `CiDeployStack`, per CloudMeter) before CI deploys are turned on.

## Known follow-ups

- **SES sandbox mode**: new SES identities can only send to verified addresses. Lifting it needs
  a manual [AWS Support production-access request](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
- **Frontend toolchain undecided**: the PRD specifies React + Vite + Tailwind; Flaunt-PORTAL and
  Flaunt-BMS are currently plain static HTML/CSS/JS with no build step.
