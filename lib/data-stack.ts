import { Stack, StackProps, RemovalPolicy, Duration, Aws, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { EnvProps, suffix, s3Suffix, subdomainPrefix } from './env-config';

export interface DataStackProps extends StackProps, EnvProps {}

/**
 * Origins allowed to PUT a profile photo. The user app is the only uploader —
 * BMS reads photos but never writes them.
 */
function uploadOrigins(envName: EnvProps['envName']): string[] {
  const host = `${subdomainPrefix(envName)}www.flaunt.network`;
  return [`https://${host}`];
}


/**
 * The Flaunt single-table store plus the profile-photo bucket.
 *
 * The full entity layout, access-pattern list and the reasoning behind each
 * index lives in docs/DATA-MODEL.md — read that before adding an index here.
 * The short version: three GSIs cover sixteen access patterns because GSI3 is
 * a sparse multi-namespace index rather than one index per query shape.
 */
export class DataStack extends Stack {
  public readonly table: dynamodb.Table;
  public readonly profilePhotoBucket: s3.Bucket;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName } = props;

    this.encryptionKey = new kms.Key(this, 'FlauntDataKey', {
      description: `Flaunt DynamoDB + S3 encryption key (${envName})`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.table = new dynamodb.Table(this, 'FlauntCoreTable', {
      // The PRD names this `Flaunt_Core_Production`. The physical name follows
      // the env-suffix convention instead (`Flaunt_Core_prod`) so dev and prod
      // can share an account, which is what the suffix helper exists for — a
      // hardcoded `_Production` would collide the moment a dev table is added.
      tableName: `Flaunt_Core${suffix(envName)}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,

      // Drives the 7-day invitation expiry (§3.4). Epoch *seconds*.
      //
      // Two things this attribute is deliberately not: it is not punctual —
      // DynamoDB deletes within roughly 48 hours of the timestamp, not at it,
      // so `expiresAt` is re-checked at read time on every accept path — and it
      // is not the record of expiry, since the row it expires is deleted. The
      // stream handler writes an ARCHIVE item so BMS and the digest keep a
      // history. See docs/DATA-MODEL.md §6.
      timeToLiveAttribute: 'expiresAt',

      // The refund engine (§3.4) is driven off this stream: TTL deletion emits
      // REMOVE, and the handler refunds the sender's token. OLD_IMAGE is what
      // makes that possible at all — the handler has to read the expired
      // invitation's status and senderId out of a row that no longer exists.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,

      removalPolicy: RemovalPolicy.RETAIN,
    });

    // GSI1 — invitation outbox. USER#<senderId> -> INVITE#<createdAt>#<inviteId>.
    // Serves "invitations I sent" on the sender's dashboard.
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // GSI2 — invitation inbox. EMAIL#<recipientEmail> -> <status>#<createdAt>.
    //
    // This index is the reason the design has more than the one GSI the PRD
    // specifies: an item holds exactly one GSI1PK value and the outbox spends
    // it on the sender, which leaves a recipient no way to list the invitations
    // addressed to them — a flow §3.4 requires. Status leads the sort key so
    // "my pending invitations" is a begins_with, not a filtered scan.
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // GSI3 — sparse, multi-namespace. Four unrelated lookups share one index
    // because no item ever belongs to more than one namespace:
    //
    //   NAME#<letter>          -> name prefix search for 3rd-degree users (§3.2)
    //   INVITE_STATUS#<status> -> the BMS invitation console (§4.2)
    //   WEBHOOK_DAY#<date>     -> the BMS Razorpay event trail (§4.2)
    //   USER_DIR#<country>     -> the BMS user ledger, split by country (§4.2)
    //
    // Projection is INCLUDE rather than ALL on purpose. These are admin-panel
    // and search reads, but the write cost lands on every user and invitation
    // in the system; projecting whole items would roughly double it to carry
    // bio and profile fields nothing here renders.
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        'entityType',
        'name',
        'country',
        'tokenBalance',
        'createdAt',
        'status',
        'senderId',
        'recipientEmail',
        'signatureValid',
        'eventType',
      ],
    });

    // Profile photos (§3.1). Uploaded directly by the client via presigned PUT,
    // read only through CloudFront — the distribution and its OAC live in the
    // frontend stack, so nothing here grants public read. S3 bucket names can't
    // contain underscores and must be globally unique, hence the hyphenated
    // suffix and the account id.
    this.profilePhotoBucket = new s3.Bucket(this, 'ProfilePhotoBucket', {
      bucketName: `flaunt-profile-photos${s3Suffix(envName)}-${Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      // A profile photo is replaced, never versioned, but an orphaned upload
      // from an abandoned signup should not be paid for forever.
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
      // Presigned PUT is issued to a signed-in user for their own key, so the
      // grant is already scoped — but the browser still needs CORS, and a
      // wildcard origin here would let any site spend a leaked presigned URL.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: uploadOrigins(envName),
          allowedHeaders: ['content-type'],
          maxAge: 3000,
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'TableStreamArn', { value: this.table.tableStreamArn! });
    new CfnOutput(this, 'ProfilePhotoBucketName', { value: this.profilePhotoBucket.bucketName });
  }
}
