/**
 * Emits the two deployable bundles from the single walkthrough source, writing
 * each into the frontend repo that owns it:
 *
 *   ../../Flaunt-PORTAL/public/index.html  -> flaunt.network      (user app only)
 *   ../../Flaunt-BMS/public/index.html     -> bms.flaunt.network  (admin only)
 *
 * Those repos deploy themselves: committing and pushing to main runs their
 * GitHub Actions workflow, which syncs public/ to S3 and invalidates CloudFront.
 * CDK provisions the hosting and never uploads content.
 *
 * Both are preview builds of a design prototype with no backend behind them, so
 * each is marked as such in the page and excluded from search indexes.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REGION = process.env.FLAUNT_REGION ?? 'ap-south-1';
const PROFILE = process.env.AWS_PROFILE ?? 'cloudmeter';

/**
 * The BMS bundle needs the deployed user-pool client id to sign anyone in.
 * Read it from the stack outputs rather than hardcoding it, and fall back to a
 * placeholder so the site still builds before the auth stack exists — the login
 * screen detects the placeholder and says so instead of failing obscurely.
 */
/**
 * Each app signs in against its own Cognito pool — members and staff are
 * deliberately separate populations — so each bundle carries its own client id,
 * read from that stack's outputs rather than hardcoded.
 */
function clientId(stack, outputKey) {
  try {
    const out = execFileSync('aws', [
      'cloudformation', 'describe-stacks',
      '--stack-name', stack,
      '--region', REGION, '--profile', PROFILE,
      '--query', `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue`,
      '--output', 'text',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out && out !== 'None') return out;
  } catch { /* stack not deployed yet, or no credentials */ }
  console.warn(`  ! ${stack} not readable — building with a placeholder client id.`);
  return '__CLIENT_ID__';
}
const CLIENT_IDS = {
  portal: clientId('FlauntAuthStackProd', 'UserPoolClientId'),
  bms: clientId('FlauntBmsAuthStackProd', 'BmsUserPoolClientId'),
};

function graphqlUrl() {
  try {
    const out = execFileSync('aws', [
      'cloudformation', 'describe-stacks', '--stack-name', 'FlauntApiStackProd',
      '--region', REGION, '--profile', PROFILE,
      '--query', "Stacks[0].Outputs[?OutputKey=='GraphqlUrl'].OutputValue", '--output', 'text',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out && out !== 'None') return out;
  } catch { /* not deployed yet */ }
  console.warn('  ! FlauntApiStackProd not readable — building without an API endpoint.');
  return '__GRAPHQL_URL__';
}
const GRAPHQL_URL = graphqlUrl();

/** Where profile photos are read from — its own distribution, beside the bucket. */
function photoBase() {
  try {
    const out = execFileSync('aws', [
      'cloudformation', 'describe-stacks', '--stack-name', 'FlauntDataStackProd',
      '--region', REGION, '--profile', PROFILE,
      '--query', "Stacks[0].Outputs[?OutputKey=='PhotoBaseUrl'].OutputValue", '--output', 'text',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out && out !== 'None') return out;
  } catch { /* not deployed yet */ }
  console.warn('  ! PhotoBaseUrl not readable — building without profile photos.');
  return '';
}
const PHOTO_BASE = photoBase();

/**
 * Identifies this build. The page polls version.json and, when the id differs
 * from its own, offers a refresh — a long-open tab otherwise keeps running the
 * previous release against a moved API.
 */
const BUILD_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'flaunt-walkthrough.html');
// This file lives at Flaunt-BACKEND/design/, so the sibling frontend repos are
// two levels up — not one.
const TARGETS = {
  portal: join(HERE, '..', '..', 'Flaunt-PORTAL', 'public'),
  bms: join(HERE, '..', '..', 'Flaunt-BMS', 'public'),
};

/**
 * Tab identity, per app.
 *
 * The mark is drawn as plain rects rather than <text>: an SVG favicon's text
 * renders inconsistently across browsers and cannot be relied on to pick up a
 * serif at all, whereas geometry always renders. At 16px a letterform beats the
 * token ring used in the UI, which turns to mush that small.
 *
 * The two apps take different grounds — oxblood for the member app, the BMS
 * navy for the console — because whoever is running this has both tabs open and
 * needs to tell them apart at a glance.
 */
function favicon(bg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<rect width="32" height="32" rx="7" fill="${bg}"/>`
    + `<rect x="11" y="8" width="3.6" height="16" fill="#FBF9F5"/>`
    + `<rect x="11" y="8" width="11" height="3.6" fill="#FBF9F5"/>`
    + `<rect x="11" y="14.6" width="7.8" height="3.3" fill="#FBF9F5"/>`
    + `</svg>`;
  return `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
}

const TAB = {
  portal: { title: 'Flaunt', icon: favicon('#6E2B2B') },
  bms: { title: 'Flaunt BMS', icon: favicon('#2B4A6E') },
};

const NOTICE = {
  portal: 'PREVIEW — design prototype. No accounts, no payments, nothing is saved.',
  bms: 'PREVIEW — design prototype. Sample data only; these are not real users.',
};

const src = await readFile(SRC, 'utf8');

for (const app of ['portal', 'bms']) {
  let out = src;

  const before = out;
  out = out.replace("var APP = 'both';", `var APP = '${app}';`);
  if (out === before) throw new Error('APP selector not found in source');

  out = out
    .replace('__AWS_REGION__', REGION)
    .replace('__CLIENT_ID__', CLIENT_IDS[app])
    .replace('__GRAPHQL_URL__', GRAPHQL_URL)
    .replace('__PHOTO_BASE__', PHOTO_BASE)
    .replace('__BUILD_ID__', BUILD_ID)
    .replace('__TITLE__', TAB[app].title)
    .replace('__FAVICON__', TAB[app].icon);

  // Search engines must not index a service that cannot yet accept anyone.
  // The CloudFront response-headers policy sets X-Robots-Tag too; this is the
  // copy that survives if the file is ever served from somewhere else.
  out = out.replace(
    '<meta name="viewport"',
    '<meta name="robots" content="noindex, nofollow">\n<meta name="viewport"'
  );

  // The bar is prototype scaffolding either way, but on a public hostname it
  // has to say plainly what this is — a visitor did not arrive knowing.
  out = out.replace(
    '<span class="tag">PROTOTYPE</span>',
    `<span class="tag">${NOTICE[app]}</span>`
  );

  const dir = TARGETS[app];
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), out);
  await writeFile(join(dir, 'version.json'), JSON.stringify({ build: BUILD_ID }) + '\n');
  console.log(`${app}: ${dir}/index.html (${out.length} bytes, build ${BUILD_ID})`);
}
