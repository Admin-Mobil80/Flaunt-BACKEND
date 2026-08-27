import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface InvitesStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  otpFromEmail: string;
  portalUrl: string;
}

/**
 * Closes the token lifecycle: when an invitation's TTL deletes it, the sender
 * gets their token back.
 *
 * A refund lost here is a silent debit against a real user — they paid for a
 * connection that never happened and nothing tells them. So the failure path is
 * built out rather than left to defaults: bisect on error so one poison record
 * cannot block the shard, bounded retries, and a dead-letter queue that keeps
 * what could not be processed instead of dropping it after the retries run out.
 */
export class InvitesStack extends Stack {
  constructor(scope: Construct, id: string, props: InvitesStackProps) {
    super(scope, id, props);

    const { table, otpFromEmail, portalUrl, envName } = props;
    const sfx = suffix(envName);

    const dlq = new sqs.Queue(this, 'ExpiryDlq', {
      queueName: `flaunt-invite-expiry-dlq${sfx}`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const expiryFn = new lambdaNode.NodejsFunction(this, 'InviteExpiryFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `flaunt-invite-expiry${sfx}`,
      entry: path.join(__dirname, '../functions/invites/expiry-stream/index.ts'),
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'InviteExpiryLogs', {
        logGroupName: `/aws/lambda/flaunt-invite-expiry${sfx}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE_NAME: table.tableName,
        OTP_FROM_EMAIL: otpFromEmail,
        PORTAL_URL: portalUrl,
      },
    });
    table.grantReadWriteData(expiryFn);
    expiryFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    expiryFn.addEventSource(new DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      // One bad record must not wedge the shard behind it.
      bisectBatchOnError: true,
      retryAttempts: 5,
      onFailure: new SqsDlq(dlq),
      // Only invitation partitions reach the function; everything else in this
      // single-table design is filtered out before it costs an invocation.
      filters: [
        lambda.FilterCriteria.filter({
          eventName: lambda.FilterRule.isEqual('REMOVE'),
          dynamodb: { Keys: { PK: { S: lambda.FilterRule.beginsWith('INVITE#') } } },
        }),
      ],
    }));

    new CfnOutput(this, 'ExpiryDlqUrl', { value: dlq.queueUrl });
  }
}
