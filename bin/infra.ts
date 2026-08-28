#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { CertStack } from '../lib/cert-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { AuthStack } from '../lib/auth-stack';
import { BmsAuthStack } from '../lib/bms-auth-stack';
import { ApiStack } from '../lib/api-stack';
import { InvitesStack } from '../lib/invites-stack';
import { BillingStack } from '../lib/billing-stack';
import { CiDeployStack } from '../lib/ci-deploy-stack';
import { EnvName } from '../lib/env-config';

const app = new cdk.App();

// Every taggable resource in every stack carries these. This AWS account hosts
// a dozen other products — CloudMeter, Skilter, Slotz, Dyrectori and more — so
// without a per-application tag nothing in Cost Explorer can be attributed.
// An App-level aspect is the only way to get complete coverage; tagging stack
// by stack guarantees something new gets missed later.
//
// A tag alone does not produce cost data: the key has to be activated as a cost
// allocation tag in Billing first, and activation is not retroactive.
cdk.Tags.of(app).add('Application', 'FLAUNT');

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const env = { account, region };
// CloudFront will only accept an ACM certificate issued in us-east-1, whatever
// region everything else lives in.
const usEast1Env = { account, region: 'us-east-1' };

// Production only. There is no dev environment by decision — the env-suffix
// convention stays in the resource names so one can be added later without
// renaming (and therefore replacing) anything that is already live.
const envName: EnvName = 'prod';

const PORTAL_DOMAIN = 'flaunt.network';
const PORTAL_ALIAS = 'www.flaunt.network';
const BMS_DOMAIN = 'bms.flaunt.network';

// PRD §4.1: exactly one identity reaches the admin console. It is enforced by
// the BMS user pool having exactly one member, not by a string comparison.
const ROOT_ADMIN_EMAIL = 'riyad@mobil80.com';
// Sender for one-time codes. The flaunt.network SES identity is already
// verified with Easy DKIM, so this address can send today.
const OTP_FROM_EMAIL = 'no-reply@flaunt.network';

const stacks: cdk.Stack[] = [];

// domainNames[0] becomes the certificate's primary DomainName; the order is
// deliberate, and changing which name is first forces a replacement on its own.
const certStack = new CertStack(app, 'FlauntCertStackProd', {
  env: usEast1Env,
  crossRegionReferences: true,
  domainNames: [PORTAL_DOMAIN, PORTAL_ALIAS, BMS_DOMAIN],
});
stacks.push(certStack);

const dataStack = new DataStack(app, 'FlauntDataStackProd', { env, envName });
stacks.push(dataStack);

// The apex serves the app directly rather than bouncing to www: someone typing
// the short name is the commonest arrival there is, and a redirect costs them a
// round trip to reach the same page. One distribution, one cache, one deploy.
stacks.push(new BillingStack(app, 'FlauntBillingStackProd', {
  env,
  envName,
  table: dataStack.table,
}));

stacks.push(new InvitesStack(app, 'FlauntInvitesStackProd', {
  env,
  envName,
  table: dataStack.table,
  otpFromEmail: OTP_FROM_EMAIL,
  portalUrl: `https://${PORTAL_DOMAIN}`,
}));

const portalStack = new FrontendStack(app, 'FlauntFrontendStackPortalProd', {
  env,
  envName,
  crossRegionReferences: true,
  certificate: certStack.certificate,
  siteName: 'portal',
  domainName: PORTAL_DOMAIN,
  extraDomainNames: [PORTAL_ALIAS],
});
stacks.push(portalStack);

const authStack = new AuthStack(app, 'FlauntAuthStackProd', {
  env,
  envName,
  table: dataStack.table,
  otpFromEmail: OTP_FROM_EMAIL,
});
stacks.push(authStack);

const bmsAuthStack = new BmsAuthStack(app, 'FlauntBmsAuthStackProd', {
  env,
  envName,
  table: dataStack.table,
  otpFromEmail: OTP_FROM_EMAIL,
  rootAdminEmail: ROOT_ADMIN_EMAIL,
});
stacks.push(bmsAuthStack);

stacks.push(new ApiStack(app, 'FlauntApiStackProd', {
  env,
  envName,
  table: dataStack.table,
  userPool: authStack.userPool,
  bmsUserPool: bmsAuthStack.userPool,
  rootAdminEmail: ROOT_ADMIN_EMAIL,
  otpFromEmail: OTP_FROM_EMAIL,
  portalUrl: `https://${PORTAL_DOMAIN}`,
}));


const bmsStack = new FrontendStack(app, 'FlauntFrontendStackBmsProd', {
  env,
  envName,
  crossRegionReferences: true,
  certificate: certStack.certificate,
  siteName: 'bms',
  domainName: BMS_DOMAIN,
});
stacks.push(bmsStack);

// Site content is published by each frontend repo's GitHub Actions workflow,
// not by CDK. This grants those workflows the narrowest access that allows it.
stacks.push(new CiDeployStack(app, 'FlauntCiDeployStack', {
  env,
  portal: portalStack,
  bms: bmsStack,
}));

stacks.forEach((stack) => cdk.Tags.of(stack).add('Environment', envName));

// Still to land, each taking dataStack.table:
//   AppSyncStack        GraphQL API + the resolver that masks 2nd-degree
//                       email addresses before they leave the API (§3.2).
//   InvitesStack        Invite/introduction mutations, the DynamoDB stream
//                       consumer and the TTL refund handler (§3.4, §3.5).
//   BillingStack        Razorpay orders + the signed webhook (§3.3).
//   NotificationsStack  SES sends (the domain identity is already verified).
//   AnalyticsStack      EventBridge 00:00 UTC digest (§4.3).
