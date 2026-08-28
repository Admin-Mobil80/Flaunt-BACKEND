import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface ApiStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  otpFromEmail: string;
  portalUrl: string;
  userPool: cognito.UserPool;
  bmsUserPool: cognito.UserPool;
  rootAdminEmail: string;
}

/**
 * The GraphQL API both apps read from.
 *
 * One endpoint, two Cognito pools: members sign in against the portal pool and
 * staff against the BMS pool, and AppSync accepts a token from either. That
 * makes authentication necessary but not sufficient — a member's token is
 * perfectly valid here, so every admin field re-checks the issuing pool and the
 * caller's email inside the resolver. Splitting the resolvers into two Lambdas
 * means the portal's execution role never holds the permissions the admin one
 * does, so a bug in a member-facing field cannot reach admin data.
 */
export class ApiStack extends Stack {
  public readonly api: appsync.GraphqlApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { table, userPool, bmsUserPool, rootAdminEmail, otpFromEmail, portalUrl, envName } = props;
    const sfx = suffix(envName);

    this.api = new appsync.GraphqlApi(this, 'FlauntGraphqlApi', {
      name: `flaunt-graphql${sfx}`,
      definition: appsync.Definition.fromFile(path.join(__dirname, '../graphql/schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.USER_POOL,
            userPoolConfig: { userPool: bmsUserPool },
          },
        ],
      },
      logConfig: { fieldLogLevel: appsync.FieldLogLevel.ERROR },
    });

    const logGroupFor = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/flaunt-api-${name}${sfx}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    const common = {
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(15),
    };

    const portalFn = new lambdaNode.NodejsFunction(this, 'PortalApiFn', {
      ...common,
      functionName: `flaunt-api-portal${sfx}`,
      logGroup: logGroupFor('portal'),
      entry: path.join(__dirname, '../functions/api/portal/index.ts'),
      environment: {
        TABLE_NAME: table.tableName,
        OTP_FROM_EMAIL: otpFromEmail,
        PORTAL_URL: portalUrl,
      },
    });
    table.grantReadWriteData(portalFn);
    // Sending an invitation emails the recipient.
    portalFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    // Creating a Razorpay order needs the key pair for whichever mode is set.
    portalFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/razorpay_dev-*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/razorpay_prod-*`,
      ],
    }));

    const adminFn = new lambdaNode.NodejsFunction(this, 'AdminApiFn', {
      ...common,
      // Admin reads scan the whole profile set; 15s left no headroom at a
      // thousand accounts.
      timeout: Duration.seconds(30),
      functionName: `flaunt-api-admin${sfx}`,
      logGroup: logGroupFor('admin'),
      entry: path.join(__dirname, '../functions/api/admin/index.ts'),
      environment: {
        TABLE_NAME: table.tableName,
        ROOT_ADMIN_EMAIL: rootAdminEmail,
        // The resolver rejects any token not issued by this pool, so a member
        // token cannot reach an admin field.
        BMS_USER_POOL_ID: bmsUserPool.userPoolId,
      },
    });
    table.grantReadWriteData(adminFn);

    const portalDs = this.api.addLambdaDataSource('PortalDataSource', portalFn);
    const adminDs = this.api.addLambdaDataSource('AdminDataSource', adminFn);

    for (const field of ['me', 'myConnections', 'secondDegree', 'myInvitations', 'tokenPrice', 'paymentMode', 'searchPeople', 'invitation', 'profile', 'connectionsOf', 'gatekeeperRequests']) {
      portalDs.createResolver(`Query${field}`, { typeName: 'Query', fieldName: field });
    }
    portalDs.createResolver('MutationsendInvitation', { typeName: 'Mutation', fieldName: 'sendInvitation' });
    portalDs.createResolver('MutationupdateProfile', { typeName: 'Mutation', fieldName: 'updateProfile' });
    portalDs.createResolver('MutationcreatePaymentOrder', { typeName: 'Mutation', fieldName: 'createPaymentOrder' });
    portalDs.createResolver('MutationacceptInvitation', { typeName: 'Mutation', fieldName: 'acceptInvitation' });
    portalDs.createResolver('MutationdeclineInvitation', { typeName: 'Mutation', fieldName: 'declineInvitation' });
    portalDs.createResolver('MutationcancelInvitation', { typeName: 'Mutation', fieldName: 'cancelInvitation' });
    portalDs.createResolver('MutationremoveConnection', { typeName: 'Mutation', fieldName: 'removeConnection' });
    for (const f of ['requestIntroduction', 'approveIntroduction', 'declineIntroduction']) {
      portalDs.createResolver(`Mutation${f}`, { typeName: 'Mutation', fieldName: f });
    }

    for (const field of ['adminUsers', 'adminStats', 'adminInvitations', 'adminPayments', 'adminPricingConfig', 'adminPaymentConfig']) {
      adminDs.createResolver(`Query${field}`, { typeName: 'Query', fieldName: field });
    }
    adminDs.createResolver('MutationadminSetTokensPerBundle', { typeName: 'Mutation', fieldName: 'adminSetTokensPerBundle' });
    adminDs.createResolver('MutationadminSetPaymentMode', { typeName: 'Mutation', fieldName: 'adminSetPaymentMode' });
    adminDs.createResolver('MutationadminSetSignupTokens', { typeName: 'Mutation', fieldName: 'adminSetSignupTokens' });

    new CfnOutput(this, 'GraphqlUrl', { value: this.api.graphqlUrl });
  }
}
