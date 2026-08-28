import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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

    /**
     * Flaunt's own webhook signing secrets, one per Razorpay environment.
     *
     * CDK generates the value; nobody has to invent one and it never travels
     * through a chat or a commit. Read it out of Secrets Manager and paste it
     * into the Razorpay dashboard when creating the webhook.
     *
     * generateSecretString only runs at creation, so redeploys never overwrite
     * a value that has been matched to a live webhook. RETAIN for the same
     * reason: destroying the stack must not silently break payment
     * verification for a webhook Razorpay still holds.
     */
    const signingSecrets = (['test', 'live'] as const).map((m) =>
      new secretsmanager.Secret(this, `RazorpayWebhookSecret${m === 'test' ? 'Test' : 'Live'}`, {
        secretName: `flaunt/razorpay_webhook_${m}`,
        description: `Razorpay webhook signing secret for Flaunt (${m} mode). Must match the secret set on the webhook in the Razorpay dashboard.`,
        removalPolicy: RemovalPolicy.RETAIN,
        generateSecretString: {
          passwordLength: 32,
          // Razorpay echoes this into an HMAC key; keep it to characters that
          // survive a copy-paste through the dashboard without escaping.
          excludePunctuation: true,
          excludeCharacters: ' ',
        },
      }));

    // Both credential sets: the handler picks by the stored payment mode, and a
    // mode switch must not need a redeploy to take effect. The API keys stay
    // shared with CloudMeter; only the signing secrets are Flaunt's own.
    webhookFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/razorpay_dev-*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/razorpay_prod-*`,
      ],
    }));
    signingSecrets.forEach((sec) => sec.grantRead(webhookFn));

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
    signingSecrets.forEach((sec, i) =>
      new CfnOutput(this, `WebhookSecretArn${i}`, { value: sec.secretArn }));
  }
}
