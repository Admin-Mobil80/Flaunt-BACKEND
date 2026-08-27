import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput, CustomResource } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface BmsAuthStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  /** Verified SES sender for the one-time codes. */
  otpFromEmail: string;
  /** The single identity permitted to sign in (PRD §4.1). */
  rootAdminEmail: string;
}

/**
 * Sign-in for the Business Management System.
 *
 * Passwordless: the only credential is a six-digit code emailed to the address,
 * implemented with Cognito's custom auth challenge triggers. There is no
 * password to set, rotate, phish or leak.
 *
 * A pool of its own, separate from the user app's — staff and members are
 * different populations, and one shared pool would mean any future bug in role
 * handling could turn a member's sign-up into an identity the admin console
 * recognises. Two pools makes that impossible rather than merely unlikely.
 *
 * Self sign-up is off and exactly one user is seeded, so PRD §4.1's "only
 * riyad@mobil80.com, everyone else 403" is enforced by the pool's membership
 * rather than by a string comparison someone can forget to write.
 */
export class BmsAuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: BmsAuthStackProps) {
    super(scope, id, props);

    const { table, otpFromEmail, rootAdminEmail, envName } = props;
    const sfx = suffix(envName);

    const fnDefaults = {
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
    };

    // An explicit log group rather than `logRetention`, which is deprecated and
    // provisions an extra custom-resource Lambda per function purely to set a
    // retention policy. Auth logs are diagnostic, not records to keep.
    const logGroupFor = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/flaunt-bms-${name.toLowerCase()}${sfx}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    const defineFn = new lambdaNode.NodejsFunction(this, 'BmsDefineAuthChallengeFn', {
      ...fnDefaults,
      functionName: `flaunt-bms-define-auth-challenge${sfx}`,
      logGroup: logGroupFor('defineauthchallenge'),
      entry: path.join(__dirname, '../functions/auth/define-auth-challenge/index.ts'),
    });

    const createFn = new lambdaNode.NodejsFunction(this, 'BmsCreateAuthChallengeFn', {
      ...fnDefaults,
      functionName: `flaunt-bms-create-auth-challenge${sfx}`,
      logGroup: logGroupFor('createauthchallenge'),
      entry: path.join(__dirname, '../functions/auth/create-auth-challenge/index.ts'),
      timeout: Duration.seconds(15),
      environment: { ...fnDefaults.environment, OTP_FROM_EMAIL: otpFromEmail },
    });
    createFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    const verifyFn = new lambdaNode.NodejsFunction(this, 'BmsVerifyAuthChallengeFn', {
      ...fnDefaults,
      functionName: `flaunt-bms-verify-auth-challenge${sfx}`,
      logGroup: logGroupFor('verifyauthchallenge'),
      entry: path.join(__dirname, '../functions/auth/verify-auth-challenge/index.ts'),
    });

    for (const fn of [createFn, verifyFn]) table.grantReadWriteData(fn);

    this.userPool = new cognito.UserPool(this, 'BmsUserPool', {
      userPoolName: `flaunt-bms-users${sfx}`,
      // The whole point: nobody can create themselves an admin identity.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      lambdaTriggers: {
        defineAuthChallenge: defineFn,
        createAuthChallenge: createFn,
        verifyAuthChallengeResponse: verifyFn,
      },
      // Losing the pool locks the only admin out of the console with no
      // self-serve way back in.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('BmsWebClient', {
      userPoolClientName: `flaunt-bms-web-client${sfx}`,
      // CUSTOM_AUTH only. No USER_PASSWORD_AUTH or SRP: there is no password,
      // and leaving those flows enabled would be a second door into the pool.
      authFlows: { custom: true },
      generateSecret: false,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // Seeding the root user needs two calls, and CfnUserPoolUser can only make
    // the first. AdminCreateUser leaves the account in FORCE_CHANGE_PASSWORD,
    // which Cognito refuses to start a CUSTOM_AUTH session for — so a permanent
    // password is set purely to move the account to CONFIRMED. That password is
    // random, never recorded, and never usable: the client has no password flow
    // enabled to present it through.
    const seedFn = new lambdaNode.NodejsFunction(this, 'BmsSeedRootUserFn', {
      ...fnDefaults,
      functionName: `flaunt-bms-seed-root-user${sfx}`,
      logGroup: logGroupFor('seedrootuser'),
      entry: path.join(__dirname, '../functions/auth/seed-root-user/index.ts'),
      environment: {},
    });
    seedFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminGetUser'],
      resources: [this.userPool.userPoolArn],
    }));

    new CustomResource(this, 'BmsRootUser', {
      serviceToken: new Provider(this, 'BmsSeedProvider', { onEventHandler: seedFn }).serviceToken,
      properties: { UserPoolId: this.userPool.userPoolId, Email: rootAdminEmail },
    });

    new CfnOutput(this, 'BmsUserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'BmsUserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'BmsRootAdminEmail', { value: rootAdminEmail });
  }
}
