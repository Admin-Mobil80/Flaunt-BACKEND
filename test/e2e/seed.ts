/**
 * Populates a real account's network so the UI can be looked at with data in it.
 *
 * The cast is created through the genuine API — sign-up, invitation, acceptance —
 * so their profiles, balances and ledger entries are exactly what the product
 * produces. Only the edges to the TARGET account are written directly.
 *
 * That distinction is deliberate. Connecting the target through the API would
 * mean signing in as them, which sends a real code to a real person's inbox and
 * mints a session for an account that is not mine to hold. Writing the same
 * mirrored rows the accept path writes gets identical data without ever
 * standing in for the account's owner.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { signUp, signIn, gql, inBatches, CAST, TestUser } from './harness';

const REGION = 'ap-south-1';
const TABLE = 'Flaunt_Core_prod';
const TARGET_EMAIL = process.argv[2] ?? 'riyad@mobil80.com';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const M_SEND = `mutation S($e:String!){ sendInvitation(email:$e){ inviteId } }`;
const M_ACCEPT = `mutation A($i:ID!){ acceptInvitation(inviteId:$i){ inviteId } }`;

const conn = (a: string, b: string) => ({ PK: `USER#${a}`, SK: `CONNECTION#${b}` });

async function main() {
  const { Item: target } = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `EMAIL#${TARGET_EMAIL.toLowerCase()}`, SK: 'UNIQUE' },
  }));
  if (!target?.userId) throw new Error(`No Flaunt account for ${TARGET_EMAIL}. Sign up first.`);
  const targetId = target.userId as string;
  console.log(`Target: ${TARGET_EMAIL} (${targetId})`);

  // 1. The cast, created properly.
  console.log(`Creating ${CAST.length} accounts…`);
  const emails = await inBatches([...CAST], 6, ([name, designation, organisation, location], i) =>
    signUp(`cast-${i}`, {
      name, designation, organisation, location,
      country: location.includes('India') ? 'IN' : location.includes('Singapore') ? 'SG' : 'PT',
      bio: `${designation} at ${organisation}, based in ${location}.`,
    }));
  const users: TestUser[] = await inBatches(emails, 4, (e) => signIn(e));
  console.log('  signed in');

  // 2. Connections among the cast, through the real flow — this is what gives
  //    the target a genuine second degree rather than a flat list.
  console.log('Connecting the cast to each other…');
  const pairs: Array<[number, number]> = [[0, 4], [0, 5], [1, 6], [1, 7], [2, 8], [3, 9], [2, 10], [3, 11]];
  await inBatches(pairs, 3, async ([from, to]) => {
    const inv = (await gql(users[from], M_SEND, { e: users[to].email })).sendInvitation;
    await gql(users[to], M_ACCEPT, { i: inv.inviteId });
  });

  // 3. The target's own edges, written directly.
  const direct = users.slice(0, 4);
  console.log(`Connecting ${TARGET_EMAIL} to ${direct.length} of them…`);
  const now = new Date().toISOString();

  for (const u of direct) {
    const inviteId = randomUUID();
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        // The mirrored pair, exactly as acceptInvitation writes it.
        { Put: { TableName: TABLE, Item: { ...conn(targetId, u.userId), entityType: 'CONNECTION',
          otherUserId: u.userId, relationshipDegree: 1, connectedAt: now, viaInviteId: inviteId } } },
        { Put: { TableName: TABLE, Item: { ...conn(u.userId, targetId), entityType: 'CONNECTION',
          otherUserId: targetId, relationshipDegree: 1, connectedAt: now, viaInviteId: inviteId } } },
        // And the accepted invitation it came from, so the Invitations tab is
        // coherent with the network rather than mysteriously empty.
        { Put: { TableName: TABLE, Item: {
          PK: `INVITE#${inviteId}`, SK: 'METADATA', entityType: 'INVITE', inviteId,
          senderId: targetId, recipientEmail: u.email, recipientUserId: u.userId,
          status: 'ACCEPTED', type: 'DIRECT', tokenCharged: true, createdAt: now, acceptedAt: now,
          GSI1PK: `USER#${targetId}`, GSI1SK: `INVITE#${now}#${inviteId}`,
          GSI2PK: `EMAIL#${u.email}`, GSI2SK: `ACCEPTED#${now}`,
          GSI3PK: 'INVITE_STATUS#ACCEPTED', GSI3SK: `${now}#${inviteId}`,
        } } },
      ],
    }));
  }

  // 4. One declined and one cancelled invitation, so the refund states are
  //    visible. Both refunded, so they net out of the balance.
  for (const [status, email] of [['REJECTED', 'success+seed-declined@simulator.amazonses.com'],
                                 ['CANCELLED', 'success+seed-cancelled@simulator.amazonses.com']] as const) {
    const inviteId = randomUUID();
    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: TABLE, Item: {
        PK: `INVITE#${inviteId}`, SK: 'METADATA', entityType: 'INVITE', inviteId,
        senderId: targetId, recipientEmail: email, status, type: 'DIRECT',
        tokenCharged: true, createdAt: now,
        GSI1PK: `USER#${targetId}`, GSI1SK: `INVITE#${now}#${inviteId}`,
        GSI2PK: `EMAIL#${email}`, GSI2SK: `${status}#${now}`,
        GSI3PK: `INVITE_STATUS#${status}`, GSI3SK: `${now}#${inviteId}`,
      } } },
      { Put: { TableName: TABLE, Item: { PK: `INVITE#${inviteId}`, SK: 'REFUND',
        entityType: 'INVITE_REFUND', refundedAt: now, reason: status } } },
    ] }));
  }

  // 5. Balance consistent with the story: four accepted invitations were paid
  //    for, the two refunded ones netted back out.
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `USER#${targetId}`, SK: 'METADATA' },
    UpdateExpression: 'SET tokenBalance = :b',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeValues: { ':b': 10 - direct.length },
  }));

  console.log(`\nDone. ${TARGET_EMAIL} now has ${direct.length} direct connections,`);
  console.log(`a second degree through them, ${direct.length + 2} invitations, and ${10 - direct.length} tokens.`);
  console.log('Remove it all with: npx tsx test/e2e/run.ts --purge');
}

main().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
