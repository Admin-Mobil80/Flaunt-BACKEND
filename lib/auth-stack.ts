import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface AuthStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  otpFromEmail: string;
}

/**
 * Sign-in for the member-facing app at flaunt.network.
 *
 * Passwordless, like the admin console: the only credential is a six-digit code
 * emailed to the address. Separate pool from BMS — members and staff are
 * different populations, and one pool would mean a member's sign-up could,
 * through any future bug in role handling, become an identity the admin console
 * recognises.
 *
 * The profile fields travel as Cognito attributes at sign-up and are written to
 * DynamoDB by the PostConfirmation trigger, together with the opening grant of
 * ten tokens, in a single transaction.
 */
export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { table, otpFromEmail, envName } = props;
    const sfx = suffix(envName);

    const logGroupFor = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/flaunt-${name.toLowerCase()}${sfx}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    const fnDefaults = {
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
    };

    const preSignUpFn = new lambdaNode.NodejsFunction(this, 'PreSignUpFn', {
      ...fnDefaults,
      functionName: `flaunt-pre-sign-up${sfx}`,
      logGroup: logGroupFor('presignup'),
      entry: path.join(__dirname, '../functions/auth/pre-sign-up/index.ts'),
    });

    const defineFn = new lambdaNode.NodejsFunction(this, 'DefineAuthChallengeFn', {
      ...fnDefaults,
      functionName: `flaunt-define-auth-challenge${sfx}`,
      logGroup: logGroupFor('defineauthchallenge'),
      entry: path.join(__dirname, '../functions/auth/define-auth-challenge/index.ts'),
    });

    const createFn = new lambdaNode.NodejsFunction(this, 'CreateAuthChallengeFn', {
      ...fnDefaults,
      functionName: `flaunt-create-auth-challenge${sfx}`,
      logGroup: logGroupFor('createauthchallenge'),
      entry: path.join(__dirname, '../functions/auth/create-auth-challenge/index.ts'),
      timeout: Duration.seconds(15),
      environment: { ...fnDefaults.environment, OTP_FROM_EMAIL: otpFromEmail },
    });
    createFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    const verifyFn = new lambdaNode.NodejsFunction(this, 'VerifyAuthChallengeFn', {
      ...fnDefaults,
      functionName: `flaunt-verify-auth-challenge${sfx}`,
      logGroup: logGroupFor('verifyauthchallenge'),
      entry: path.join(__dirname, '../functions/auth/verify-auth-challenge/index.ts'),
    });

    const postConfirmationFn = new lambdaNode.NodejsFunction(this, 'PostConfirmationFn', {
      ...fnDefaults,
      functionName: `flaunt-post-confirmation${sfx}`,
      logGroup: logGroupFor('postconfirmation'),
      entry: path.join(__dirname, '../functions/auth/post-confirmation/index.ts'),
    });

    for (const fn of [createFn, verifyFn, postConfirmationFn]) table.grantReadWriteData(fn);

    this.userPool = new cognito.UserPool(this, 'FlauntUserPool', {
      userPoolName: `flaunt-users${sfx}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        // country drives tax and pricing (§3.3) and is captured at signup.
        country: new cognito.StringAttribute({ minLen: 2, maxLen: 2, mutable: true }),
        designation: new cognito.StringAttribute({ maxLen: 100, mutable: true }),
        organisation: new cognito.StringAttribute({ maxLen: 100, mutable: true }),
        location: new cognito.StringAttribute({ maxLen: 80, mutable: true }),
        // 2048 is Cognito's hard ceiling for a custom attribute, and it is why
        // the bio's byte cap is 2048 rather than something roomier: 300 words of
        // ordinary prose is ~1800 characters, so a conforming bio fits, but the
        // limit is Cognito's and not a product decision. It moves once profile
        // writes go through the API instead of through sign-up attributes.
        bio: new cognito.StringAttribute({ maxLen: 2048, mutable: true }),
      },
      // No password exists to recover.
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: RemovalPolicy.RETAIN,
      lambdaTriggers: {
        preSignUp: preSignUpFn,
        defineAuthChallenge: defineFn,
        createAuthChallenge: createFn,
        verifyAuthChallengeResponse: verifyFn,
        postConfirmation: postConfirmationFn,
      },
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `flaunt-web-client${sfx}`,
      // Custom auth only — enabling SRP or USER_PASSWORD would be a second door
      // into a pool that has no passwords.
      authFlows: { custom: true },
      generateSecret: false,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
      // No explicit read/write attribute lists. Cognito requires every REQUIRED
      // attribute to be client-writable, so an explicit writeAttributes that
      // omits `email` is rejected outright with "Invalid write attributes" —
      // and email is both required and immutable here. The defaults grant the
      // client its own pool's attributes, which is what sign-up needs.
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
