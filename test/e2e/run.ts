/**
 * Exercises the whole token lifecycle against the deployed stack.
 *
 * Assertions are on facts that would cost real money or leak real data if they
 * were wrong — balances, refund counts, who can see whose address — not on
 * whether a call returned 200.
 */
import { signUp, signIn, gql, cleanup, inBatches, CAST, TestUser } from './harness';

let pass = 0, fail = 0;
const results: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name: string, actual: any, expected: any) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const Q_ME = `query { me { userId tokenBalance connectionCount name } }`;
const M_SEND = `mutation S($e:String!){ sendInvitation(email:$e){ inviteId status } }`;
const M_ACCEPT = `mutation A($i:ID!){ acceptInvitation(inviteId:$i){ inviteId status } }`;
const M_DECLINE = `mutation D($i:ID!){ declineInvitation(inviteId:$i){ inviteId status } }`;
const M_CANCEL = `mutation C($i:ID!){ cancelInvitation(inviteId:$i){ inviteId status } }`;

const balance = async (u: TestUser) => (await gql(u, Q_ME)).me.tokenBalance;

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const bulk = Number(args.find((a) => /^\d+$/.test(a)) ?? 0);

  console.log('Cleaning up any leftovers from a previous run…');
  console.log('  ', JSON.stringify(await cleanup()));

  console.log('\nCreating accounts (sign-up sends no email)…');
  const [aE, bE, cE, dE] = await Promise.all([
    signUp('alice', { name: 'Alice Test', country: 'IN' }),
    signUp('bob', { name: 'Bob Test', country: 'SG' }),
    signUp('carol', { name: 'Carol Test' }),
    signUp('dave', { name: 'Dave Test' }),
  ]);
  const [A, B, C, D] = [await signIn(aE), await signIn(bE), await signIn(cE), await signIn(dE)];

  // --- opening grant ---
  eq('sign-up grants exactly 10 tokens', await balance(A), 10);
  eq('a second account is independent', await balance(B), 10);

  // --- front-loaded spend ---
  const inv1 = (await gql(A, M_SEND, { e: bE })).sendInvitation;
  eq('sending debits one token immediately', await balance(A), 9);
  eq('invitation opens as PENDING', inv1.status, 'PENDING');

  // --- accept forms a mirrored connection ---
  await gql(B, M_ACCEPT, { i: inv1.inviteId });
  eq('accepting keeps the token spent', await balance(A), 9);
  eq('sender sees the connection', (await gql(A, Q_ME)).me.connectionCount, 1);
  eq('recipient sees it too (mirrored)', (await gql(B, Q_ME)).me.connectionCount, 1);

  // --- decline refunds, exactly once ---
  const inv2 = (await gql(A, M_SEND, { e: cE })).sendInvitation;
  eq('second send debits again', await balance(A), 8);
  await gql(C, M_DECLINE, { i: inv2.inviteId });
  eq('declining returns the token', await balance(A), 9);
  let doubleRefund = false;
  try { await gql(C, M_DECLINE, { i: inv2.inviteId }); doubleRefund = (await balance(A)) > 9; } catch { /* expected */ }
  check('a repeated decline cannot refund twice', !doubleRefund);

  // --- cancel refunds the sender ---
  const inv3 = (await gql(A, M_SEND, { e: dE })).sendInvitation;
  eq('third send debits', await balance(A), 8);
  await gql(A, M_CANCEL, { i: inv3.inviteId });
  eq('cancelling returns the token', await balance(A), 9);

  // --- authorization boundaries ---
  let wrongRecipient = false;
  const inv4 = (await gql(A, M_SEND, { e: cE })).sendInvitation;
  try { await gql(D, M_ACCEPT, { i: inv4.inviteId }); wrongRecipient = true; } catch { /* expected */ }
  check('someone else cannot accept your invitation', !wrongRecipient);
  let strangerCancel = false;
  try { await gql(B, M_CANCEL, { i: inv4.inviteId }); strangerCancel = true; } catch { /* expected */ }
  check('only the sender can cancel', !strangerCancel);
  await gql(C, M_ACCEPT, { i: inv4.inviteId });

  // --- degree resolution and masking ---
  // A—B and A—C are direct. B and C are second degree to each other.
  const bSeesC: any = (await gql(B, `query P($id:ID!){ profile(userId:$id){ degree primaryEmail secondaryEmail location viaName } }`, { id: C.userId })).profile;
  eq('B sees C as second degree', bSeesC.degree, 2);
  check('second-degree email is masked', typeof bSeesC.primaryEmail === 'string' && bSeesC.primaryEmail.includes('*'));
  check('the real address is never sent', bSeesC.primaryEmail !== cE);
  eq('second-degree location is withheld', bSeesC.location, null);
  eq('second-degree secondary email is withheld', bSeesC.secondaryEmail, null);
  check('the mutual connection is named', typeof bSeesC.viaName === 'string' && bSeesC.viaName.length > 0);

  const aSeesB: any = (await gql(A, `query P($id:ID!){ profile(userId:$id){ degree primaryEmail } }`, { id: B.userId })).profile;
  eq('first-degree sees the real address', aSeesB.primaryEmail, bE);

  const dSeesB: any = (await gql(D, `query P($id:ID!){ profile(userId:$id){ degree primaryEmail } }`, { id: B.userId })).profile;
  eq('an unconnected stranger gets no address', dSeesB.primaryEmail, null);
  eq('and no degree', dSeesB.degree, null);

  // --- connectionsOf is limited to direct contacts ---
  const viaA = (await gql(B, `query C($id:ID!){ connectionsOf(userId:$id){ userId degree } }`, { id: A.userId })).connectionsOf;
  check("a direct contact's connections are visible", Array.isArray(viaA) && viaA.length >= 1);
  let peeked = false;
  try { await gql(D, `query C($id:ID!){ connectionsOf(userId:$id){ userId } }`, { id: B.userId }); peeked = true; } catch { /* expected */ }
  check('a stranger cannot enumerate your network', !peeked);

  // --- admin surface rejects a member token ---
  let memberReachedAdmin = false;
  try { await gql(A, `query { adminStats { totalUsers } }`); memberReachedAdmin = true; } catch { /* expected */ }
  check('a member token cannot reach admin fields', !memberReachedAdmin);

  // --- the balance floor, under genuine concurrency ---
  const E = await signIn(await signUp('erin', { name: 'Erin Test' }));
  const targets = Array.from({ length: 14 }, (_, i) => `success+e2e-flood-${i}@simulator.amazonses.com`);
  const outcomes = await Promise.allSettled(targets.map((e) => gql(E, M_SEND, { e })));
  const sent = outcomes.filter((o) => o.status === 'fulfilled').length;
  const finalBalance = await balance(E);
  eq('14 concurrent sends against 10 tokens: exactly 10 succeed', sent, 10);
  eq('balance floors at zero, never negative', finalBalance, 0);

  if (bulk > 0) {
    console.log(`\nBulk: creating ${bulk} accounts in batches…`);
    const labels = Array.from({ length: bulk }, (_, i) => `bulk-${i}`);
    const emails = await inBatches(labels, 10, (l, i) => {
      const [name, designation, organisation, location] = CAST[i % CAST.length];
      const suffix = Math.floor(i / CAST.length);
      return signUp(l, {
        name: suffix ? `${name} ${suffix + 1}` : name,
        designation, organisation, location,
        country: location.includes('India') ? 'IN' : (location.includes('Singapore') ? 'SG' : 'PT'),
        bio: `${designation} at ${organisation}. Test account created by the end-to-end harness.`,
      });
    });
    const users = await inBatches(emails, 6, (e) => signIn(e));
    const balances = await inBatches(users, 10, balance);
    eq(`all ${bulk} accounts granted exactly 10`, [...new Set(balances)], [10]);

    // A hub with real connections, so the network and second-degree views have
    // something to show rather than a list of strangers.
    console.log('Building a connected network…');
    const hub = users[0];
    const spokes = users.slice(1, Math.min(9, users.length));
    const invites = await inBatches(spokes, 4, async (u) =>
      (await gql(hub, M_SEND, { e: u.email })).sendInvitation);
    await inBatches(spokes, 4, (u, i) => gql(u, M_ACCEPT, { i: invites[i].inviteId }));

    // Each spoke invites two more, giving the hub a real second degree.
    const rest = users.slice(9);
    if (rest.length) {
      await inBatches(spokes.slice(0, 4), 2, async (sp, i) => {
        const targets = rest.slice(i * 2, i * 2 + 2);
        for (const t of targets) {
          const inv = (await gql(sp, M_SEND, { e: t.email })).sendInvitation;
          await gql(t, M_ACCEPT, { i: inv.inviteId });
        }
      });
    }
    const hubMe = (await gql(hub, Q_ME)).me;
    const hubSecond = (await gql(hub, `query { secondDegree { userId } }`)).secondDegree;
    check(`hub has ${hubMe.connectionCount} direct connections`, hubMe.connectionCount > 0);
    check(`hub has ${hubSecond.length} second-degree contacts`, hubSecond.length > 0);
    console.log(`  hub account: ${hub.email}`);
  }

  console.log('\n' + results.join('\n'));
  console.log(`\n  ${pass} passed, ${fail} failed`);

  if (keep) {
    console.log('\n--keep: leaving the test data in place so the UI is populated.');
    console.log('  Run `npx tsx test/e2e/run.ts --purge` to remove it.');
  } else {
    console.log('\nCleaning up…');
    console.log('  ', JSON.stringify(await cleanup()));
  }
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes('--purge')) {
  cleanup().then((r) => { console.log('Purged:', JSON.stringify(r)); process.exit(0); });
} else {
  main().catch(async (e) => {
  console.error('\nHARNESS ERROR:', e.message);
  console.log(results.join('\n'));
  console.log('Cleaning up after failure…');
    try { console.log('  ', JSON.stringify(await cleanup())); } catch { /* best effort */ }
    process.exit(1);
  });
}
