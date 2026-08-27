import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';

/**
 * The flaunt.network hosted zone, which already exists and is NOT managed here.
 *
 * It was created by hand before this repo existed, the registrar is delegated to
 * its four nameservers, and an SES domain identity with Easy DKIM is verified
 * against it (six live _domainkey CNAMEs). Declaring `new HostedZone(...)` would
 * create a *second* zone for the same name with different nameservers: the
 * registrar would keep pointing at the original, every record CDK wrote would
 * resolve nowhere, and ACM validation would hang until CloudFormation timed out.
 * That exact duplicate already exists in this account for cloudmeter.io.
 *
 * This is a plain attribute import rather than a stack of its own, for two
 * reasons: an import-only stack has no resources, and CloudFormation rejects a
 * template with an empty Resources block; and because these are literal values
 * rather than CloudFormation tokens, each stack can resolve the zone locally and
 * no cross-stack (or cross-region) reference is created for DNS at all.
 */
export const HOSTED_ZONE_ID = 'Z07701301Z9Q68XUCL143';
export const ZONE_NAME = 'flaunt.network';

export function flauntZone(scope: Construct, id = 'FlauntZone'): route53.IHostedZone {
  return route53.HostedZone.fromHostedZoneAttributes(scope, id, {
    hostedZoneId: HOSTED_ZONE_ID,
    zoneName: ZONE_NAME,
  });
}
