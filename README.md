# Flaunt Backend

Shared serverless backend for Flaunt, deployed via [AWS SAM](https://docs.aws.amazon.com/serverless-application-model/) / CloudFormation. Node.js 20.x on Lambda. No features are decided yet — this repo provisions **foundational, empty resources** for each planned AWS service, ready for real business logic to land on top:

| Service | What's provisioned now |
|---|---|
| API Gateway | `AWS::Serverless::HttpApi` at `api.flaunt.network`, one placeholder `GET /health` Lambda |
| Cognito | User pool + app client (email as username, SRP + refresh-token auth flows) |
| AppSync | GraphQL API at `graphql.flaunt.network`, Cognito User Pool auth (+ IAM as additional auth mode), one placeholder `Query.health` resolver |
| DynamoDB | `flaunt-table`, single-table design (PK/SK + GSI1), on-demand billing, point-in-time recovery |
| EventBridge | `flaunt-event-bus`, no rules yet |
| SQS | `flaunt-queue` + `flaunt-queue-dlq` (redrive after 5 receives), no consumers yet |
| SES | Domain identity for `flaunt.network` with Easy DKIM, DNS records auto-created |

## One-time account setup (do this before the first push to `main`)

1. Fix/confirm your local AWS CLI credentials (`aws sts get-caller-identity`).
2. Deploy the GitHub OIDC bootstrap stack manually, **once**, from a machine with valid credentials — never from CI:
   ```bash
   aws cloudformation deploy \
     --template-file bootstrap/github-oidc.yaml \
     --stack-name flaunt-github-oidc \
     --capabilities CAPABILITY_NAMED_IAM
   ```
   Before running this, check `aws iam list-open-id-connect-providers` — if a `token.actions.githubusercontent.com` provider already exists in this account, remove the `GitHubOidcProvider` resource from the template first and reference the existing one instead.
3. Look up your Route 53 hosted zone ID for `flaunt.network`:
   ```bash
   aws route53 list-hosted-zones-by-name --dns-name flaunt.network
   ```
4. In [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), replace the two placeholders:
   - `DEPLOY_ROLE_ARN` — the `flaunt-backend-deploy-role` ARN from step 2's stack output
   - `HOSTED_ZONE_ID` — the value from step 3
5. Push to `main`. This deploy is independent of Flaunt-PORTAL/Flaunt-BMS and can happen any time after step 2.

## Known follow-ups (not automatable via CloudFormation)

- **SES sandbox mode**: new SES identities start in sandbox (can only send to verified addresses). Lifting this requires a manual [AWS Support production-access request](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
- **CI privilege note**: the `flaunt-backend-deploy-role` can create/attach IAM policies scoped to `role/flaunt-backend-*` (needed because SAM auto-manages Lambda execution roles). This is inherent to the SAM deploy model — mitigated by the resource-prefix scoping and a `PassedToService: lambda.amazonaws.com` condition in `bootstrap/github-oidc.yaml`. Consider branch protection on `main`.

## Local development

```bash
sam build
sam local invoke HealthFunction
```

Requires the [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) (not currently installed on this machine) and valid AWS credentials for `sam deploy`.
