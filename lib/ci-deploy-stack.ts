import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { FrontendStack } from './frontend-stack';

/**
 * The account already has exactly one GitHub OIDC provider, shared by several
 * unrelated projects. AWS permits only one per URL per account, so this is
 * imported and never created — declaring it would fail the stack outright.
 */
const GITHUB_OIDC_PROVIDER_ARN =
  'arn:aws:iam::231427841372:oidc-provider/token.actions.githubusercontent.com';
const GITHUB_ORG = 'Admin-Mobil80';
const PORTAL_REPO = 'Flaunt-PORTAL';
const BMS_REPO = 'Flaunt-BMS';

export interface CiDeployStackProps extends StackProps {
  portal: FrontendStack;
  bms: FrontendStack;
}

/**
 * The IAM role GitHub Actions assumes — via OIDC, with no stored access keys —
 * to publish the portal and BMS sites.
 *
 * It can write to exactly two buckets and invalidate exactly two distributions.
 * It cannot touch DynamoDB, Cognito, SES or any other project in this shared
 * account, so a compromised workflow cannot reach the token ledger.
 */
export class CiDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: CiDeployStackProps) {
    super(scope, id, props);

    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this, 'GitHubOidcProvider', GITHUB_OIDC_PROVIDER_ARN,
    );

    const role = new iam.Role(this, 'GitHubDeployProdRole', {
      roleName: 'flaunt-github-deploy-prod',
      description:
        "Assumed by GitHub Actions (OIDC) to publish Flaunt's frontends from the main branch only.",
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          // Admin-Mobil80 has GitHub's "use immutable IDs" OIDC setting enabled,
          // so the real `sub` claim is `repo:org@orgId/repo@repoId:ref:...` —
          // not the plain `repo:org/repo:ref:...` the AWS docs lead with. A
          // trust policy written the documented way is silently denied at
          // AssumeRoleWithWebIdentity. This was established the hard way on
          // CloudMeter, from a CloudTrail denial record. Wildcarding the numeric
          // id segments matches either form without hardcoding each repo's id.
          StringLike: {
            'token.actions.githubusercontent.com:sub': [
              `repo:${GITHUB_ORG}@*/${PORTAL_REPO}@*:ref:refs/heads/main`,
              `repo:${GITHUB_ORG}@*/${BMS_REPO}@*:ref:refs/heads/main`,
            ],
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    for (const site of [props.portal, props.bms]) {
      site.bucket.grantReadWrite(role);
      role.addToPolicy(new iam.PolicyStatement({
        // GetInvalidation as well as CreateInvalidation: the workflow waits for
        // the invalidation to finish before reporting success, and the waiter
        // polls GetInvalidation. Granting only Create lets the deploy work but
        // fails the run at the wait — content live, workflow red.
        actions: [
          'cloudfront:CreateInvalidation',
          'cloudfront:GetInvalidation',
          'cloudfront:ListInvalidations',
        ],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${site.distribution.distributionId}`,
        ],
      }));
    }

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
    new CfnOutput(this, 'PortalBucket', { value: props.portal.bucket.bucketName });
    new CfnOutput(this, 'PortalDistributionId', { value: props.portal.distribution.distributionId });
    new CfnOutput(this, 'BmsBucket', { value: props.bms.bucket.bucketName });
    new CfnOutput(this, 'BmsDistributionId', { value: props.bms.distribution.distributionId });
  }
}
