import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface BillingStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
}

/**
 * The Razorpay webhook endpoint.
 *
 * A plain HTTP API with NO authorizer, which is correct and worth stating:
 * Razorpay cannot present a Cognito token, so the endpoint must be publicly
 * reachable. Its authentication is the HMAC signature over the request body,
 * checked inside the handler — which is why that check, and the order lookup
 * beside it, carry the whole weight of not crediting tokens to strangers.
 */
export class BillingStack extends Stack {
  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    const { table, envName } = props;
    const sfx = suffix(envName);

    const webhookFn = new lambdaNode.NodejsFunction(this, 'RazorpayWebhookFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `flaunt-razorpay-webhook${sfx}`,
      entry: path.join(__dirname, '../functions/billing/webhook/index.ts'),
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(20),
      logGroup: new logs.LogGroup(this, 'RazorpayWebhookLogs', {
        logGroupName: `/aws/lambda/flaunt-razorpay-webhook${sfx}`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantReadWriteData(webhookFn);

    // Both credential sets: the handler picks by the stored payment mode, and a
    // mode switch must not need a redeploy to take effect.
    webhookFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/razorpay_dev-*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/razorpay_prod-*`,
      ],
    }));

    const api = new apigw.HttpApi(this, 'BillingApi', {
      apiName: `flaunt-billing${sfx}`,
      description: 'Razorpay webhook receiver. Authenticated by HMAC, not by an authorizer.',
    });
    api.addRoutes({
      path: '/webhooks/razorpay',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    new CfnOutput(this, 'WebhookUrl', { value: `${api.apiEndpoint}/webhooks/razorpay` });
  }
}
