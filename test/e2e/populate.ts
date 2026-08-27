/**
 * Populates the system to a realistic size for looking at the UI.
 *
 * Costs ZERO emails. Sign-up sends nothing — PreSignUp auto-confirms, so the
 * PostConfirmation trigger creates each profile and grants its ten tokens
 * silently. Only sign-IN sends a code, and nothing here signs in: the social
 * graph is written as the same mirrored rows acceptInvitation writes.
 *
 * That matters because this account's SES reputation is shared with several
 * live products. The e2e suite already exercises the real invitation path;
 * repeating it a hundred times would add no coverage and real risk.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { signUp, inBatches } from './harness';

const REGION = 'ap-south-1';
const TABLE = 'Flaunt_Core_prod';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const TARGET_EMAIL = process.argv[3] ?? 'riyad@mobil80.com';
const TOTAL = Number(process.argv[2] ?? 100);

const FIRST = ['Aarav','Priya','Daniel','Meera','Tomas','Sana','Wei Lin','Aisha','Rahul','Lucia','Kwame','Anjali','Marcus','Ines','Yusuf','Nadia','Arjun','Chidi','Sofia','Ravi','Leila','Mateo','Hana','Omar','Grace','Vikram','Elena','Tunde','Divya','Pablo','Mei','Karim','Rosa','Sanjay','Amara','Felix','Noor','Ishaan','Clara','Bilal','Zara','Hugo','Neha','Kofi','Alina','Rohan','Emeka','Sara','Dev','Maya'];
const LAST = ['Mehta','Nair','Osei','Krishnan','Ferreira','Qureshi','Tan','Bello','Deshpande','Moretti','Asante','Rao','Chen','Almeida','Rahman','Haddad','Iyer','Okafor','Rossi','Menon','Farah','Silva','Kimura','Aziz','Mwangi','Shah','Petrova','Adeyemi','Pillai','Ortega'];
const ROLES: Array<[string, string]> = [
  ['Design director','Ather Energy'],['Infrastructure engineer','Paystack'],
  ['Clinical research lead','Narayana Health'],['Founder','Lote 9'],
  ['Corporate counsel','Trilegal'],['Quantitative researcher','GIC'],
  ['Supply chain lead','Twiga Foods'],['Staff SRE','Razorpay'],
  ['Product manager','Bending Spoons'],['Head of risk','Flutterwave'],
  ['Data scientist','Swiggy'],['Portfolio manager','Temasek'],
  ['Principal engineer','Zerodha'],['Partner','AZB'],
  ['Head of design','Postman'],['Operations lead','Zepto'],
];
const PLACES: Array<[string, string]> = [
  ['Bengaluru, India','IN'],['Mumbai, India','IN'],['Chennai, India','IN'],['Pune, India','IN'],
  ['Singapore','SG'],['Lisbon, Portugal','PT'],['Accra, Ghana','GH'],['Lagos, Nigeria','NG'],
  ['Milan, Italy','IT'],['Dubai, UAE','AE'],
];

const pick = <T,>(a: readonly T[], i: number) => a[i % a.length];
const conn = (a: string, b: string) => ({ PK: `USER#${a}`, SK: `CONNECTION#${b}` });

/**
 * A DynamoDB Scan returns at most 1MB and then stops, without erroring — so an
 * unpaginated scan silently works on a subset. It read 796 of 1000 profiles
 * before this was fixed, and the only symptom was a thinner graph than asked
 * for.
 */
async function scanAll(params: any) {
  const items: any[] = [];
  let ExclusiveStartKey: any = undefined;
  do {
    const r: any = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** BatchWrite caps at 25 items per request. */
async function putAll(items: any[]) {
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({
      RequestItems: { [TABLE]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) },
    }));
  }
}

async function main() {
  const { Item: t } = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `EMAIL#${TARGET_EMAIL.toLowerCase()}`, SK: 'UNIQUE' },
  }));
  if (!t?.userId) throw new Error(`No account for ${TARGET_EMAIL}`);
  const targetId = t.userId as string;

  const existing = await scanAll({
    TableName: TABLE, FilterExpression: 'entityType = :t',
    ExpressionAttributeValues: { ':t': 'USER' }, ProjectionExpression: 'PK',
  });
  const need = Math.max(0, TOTAL - existing.length);
  console.log(`${existing.length} accounts exist; creating ${need} more (0 emails sent).`);

  const specs = Array.from({ length: need }, (_, i) => {
    const n = existing.length + i;
    const [designation, organisation] = pick(ROLES, n * 7 + 3);
    const [location, country] = pick(PLACES, n * 5 + 1);
    return {
      label: `pop-${n}`,
      name: `${pick(FIRST, n * 13 + 5)} ${pick(LAST, n * 11 + 2)}`,
      designation, organisation, location, country,
      bio: `${designation} at ${organisation}, based in ${location}. Interested in how small teams keep quality up as they grow.`,
    };
  });

  await inBatches(specs, 8, (s) => signUp(s.label, s));
  console.log('  accounts created');

  // Read everyone back, then wire a graph directly — the same mirrored rows
  // acceptInvitation writes, so the app cannot tell the difference.
  const all = await scanAll({
    TableName: TABLE, FilterExpression: 'entityType = :t',
    ExpressionAttributeValues: { ':t': 'USER' }, ProjectionExpression: 'PK, #n',
    ExpressionAttributeNames: { '#n': 'name' },
  });
  const ids = all.map((u: any) => String(u.PK).replace('USER#', '')).filter((id) => id !== targetId);
  console.log(`Wiring a graph across ${ids.length + 1} accounts…`);

  const now = new Date().toISOString();
  const edges = new Set<string>();
  const rows: any[] = [];
  const link = (a: string, b: string) => {
    if (a === b) return;
    const key = [a, b].sort().join('|');
    if (edges.has(key)) return;
    edges.add(key);
    const viaInviteId = randomUUID();
    rows.push({ ...conn(a, b), entityType: 'CONNECTION', otherUserId: b, relationshipDegree: 1, connectedAt: now, viaInviteId });
    rows.push({ ...conn(b, a), entityType: 'CONNECTION', otherUserId: a, relationshipDegree: 1, connectedAt: now, viaInviteId });
  };

  // The target gets a substantial first degree, and each of those a network of
  // their own, so the second-degree tab has real depth rather than a handful.
  const directCount = Math.min(30, ids.length);
  const directs = ids.slice(0, directCount);
  directs.forEach((id) => link(targetId, id));
  const rest = ids.slice(directCount);
  directs.forEach((d, i) => {
    // Uneven, so counts look like a real network rather than a grid. Thirty
    // contacts averaging ~45 connections each puts the target's second degree
    // comfortably into the thousands, which is the case worth designing for.
    const fanout = 25 + ((i * 7) % 40);
    for (let j = 0; j < fanout; j++) link(d, rest[(i * 31 + j * 13) % rest.length]);
  });
  // A little connectivity among the tail as well.
  rest.forEach((id, i) => { if (i % 3 === 0) link(id, rest[(i * 11 + 4) % rest.length]); });

  await putAll(rows);
  console.log(`  ${edges.size} connections written (${rows.length} rows)`);
  console.log(`\n${TARGET_EMAIL}: ${directCount} direct connections.`);
  console.log('Emails sent by this script: 0');
}

main().catch((e) => { console.error('POPULATE FAILED:', e.message); process.exit(1); });
