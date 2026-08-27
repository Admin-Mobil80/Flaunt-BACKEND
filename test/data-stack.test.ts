import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';

function synth(envName: 'dev' | 'prod') {
  const app = new cdk.App();
  const stack = new DataStack(app, `FlauntDataStack-${envName}`, {
    envName,
    env: { account: '111111111111', region: 'ap-south-1' },
  });
  return Template.fromStack(stack);
}

describe('DataStack table', () => {
  const template = synth('prod');

  test('is named per the env-suffix convention', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Flaunt_Core_prod',
    });
  });

  test('uses the PK/SK single-table key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  // The refund engine reads senderId and status out of rows TTL has already
  // deleted, so OLD_IMAGES specifically is load-bearing — NEW_IMAGE alone would
  // silently break every expiry refund.
  test('streams both images, for the TTL refund handler', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
  });

  test('expires invitations off the expiresAt attribute', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  test('protects the token ledger: PITR, deletion protection, CMK, retain', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
      SSESpecification: { SSEEnabled: true },
    });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('declares exactly the three indexes the access patterns need', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'GSI1' }),
        Match.objectLike({ IndexName: 'GSI2' }),
        Match.objectLike({ IndexName: 'GSI3' }),
      ]),
    });
    const tables = template.findResources('AWS::DynamoDB::Table');
    const gsis = Object.values(tables)[0].Properties.GlobalSecondaryIndexes;
    expect(gsis).toHaveLength(3);
  });

  // GSI3 fans out to every user and invitation write. An ALL projection here is
  // a silent doubling of write cost for admin-only reads.
  test('keeps GSI3 on a narrow INCLUDE projection', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'GSI3',
          Projection: Match.objectLike({ ProjectionType: 'INCLUDE' }),
        }),
      ]),
    });
  });
});

describe('DataStack profile photo bucket', () => {
  test('is private and never CORS-open to the whole web', () => {
    const template = synth('prod');
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ['PUT'],
            AllowedOrigins: ['https://www.flaunt.network'],
          }),
        ],
      },
    });
  });

  test('scopes upload origin to the dev host in dev', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [Match.objectLike({ AllowedOrigins: ['https://dev.www.flaunt.network'] })],
      },
    });
  });
});

describe('dev and prod do not collide', () => {
  test('table names differ by env', () => {
    synth('dev').hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'Flaunt_Core_dev' });
  });
});
