import { Stack, StackProps, RemovalPolicy, Duration, Aws, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { EnvProps, s3Suffix } from './env-config';
import { flauntZone } from './zone';

export interface FrontendStackProps extends StackProps, EnvProps {
  certificate: acm.ICertificate;
  /** Short identifier used in resource names, e.g. 'portal' or 'bms'. */
  siteName: string;
  /** Primary hostname this distribution answers on. */
  domainName: string;
  /** Additional hostnames on the same distribution (e.g. www beside the apex). */
  extraDomainNames?: string[];
}

/**
 * One bucket plus one CloudFront distribution per site. Portal and BMS are
 * separate applications with separate distributions and separate caches; they
 * share only the hosted zone and the certificate that covers both hostnames.
 *
 * This stack provisions the hosting and nothing else — it deliberately uploads
 * no content. Site files are published by each frontend repo's own GitHub
 * Actions workflow, which assumes the role in CiDeployStack and syncs to the
 * bucket below. Keeping the two apart means a copy change ships by pushing to
 * Flaunt-PORTAL, without a CloudFormation deploy and without CDK credentials.
 */
export class FrontendStack extends Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const {
      envName, certificate, siteName, domainName, extraDomainNames = [],
    } = props;

    // S3 bucket names cannot contain underscores and must be globally unique,
    // hence the hyphenated env suffix and the account id.
    this.bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `flaunt-${siteName}-frontend${s3Suffix(envName)}-${Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // A preview build must not be indexed: the pages describe a service that
    // cannot yet accept anyone, and a search result for it would be a promise
    // the backend cannot keep.
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'HeadersPolicy', {
      responseHeadersPolicyName: `flaunt-${siteName}-headers${s3Suffix(envName)}`,
      customHeadersBehavior: {
        customHeaders: [
          { header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true },
        ],
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      domainNames: [domainName, ...extraDomainNames],
      certificate,
      defaultRootObject: 'index.html',
      // The site is one hash-routed page, so any path that is not a real object
      // must still return that page rather than S3's XML error document.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const hostedZone = flauntZone(this);
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
    // Every hostname the distribution answers on needs its own alias record —
    // an alias listed on the distribution with no DNS pointing at it resolves
    // nowhere, which looks exactly like a broken deploy.
    for (const host of [domainName, ...extraDomainNames]) {
      // The apex strips to an empty recordName, which Route 53 reads as the
      // zone itself — precisely what a bare-domain alias needs.
      const recordName = host.replace(/\.?flaunt\.network$/, '');
      const suffix = host === domainName ? '' : `-${host.replace(/[^a-zA-Z0-9]/g, '')}`;
      new route53.ARecord(this, `AliasA${suffix}`, { zone: hostedZone, recordName, target });
      new route53.AaaaRecord(this, `AliasAAAA${suffix}`, { zone: hostedZone, recordName, target });
    }

    new CfnOutput(this, 'SiteUrl', { value: `https://${domainName}` });
    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
