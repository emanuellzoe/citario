// One-time testnet setup. Creates fresh accounts through the public testnet
// faucet, deploys and initialises the contract, registers the demo article and
// funds two reader agents. Writes everything a later `pnpm run demo` needs to .env
// and data/ (both gitignored). No mainnet, no real funds.
//
//   pnpm run setup:testnet            # skips if .env already has a contract
//   pnpm run setup:testnet --force    # new accounts, new contract
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { cfg, DATA_DIR, fromNear, ROOT } from '../packages/citario/src/config.ts';
import { rpc } from '../packages/citario/src/chain.ts';
import { sha256 } from '../packages/citario/src/text.ts';

const force = process.argv.includes('--force');
if (cfg.contractId && !force) {
  console.log(`Already set up: contract ${cfg.contractId}. Use \`pnpm run setup:testnet --force\` for new accounts.`);
  process.exit(0);
}
const WASM = join(ROOT, 'contracts/citario/target/near/citario.wasm');
if (!existsSync(WASM)) throw new Error('contract wasm missing: run `pnpm run build:contract` first');

const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const TGAS = 1_000_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function faucetAccount(id: string, kp: KeyPair) {
  const r = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${(await r.text()).slice(0, 200)}`);
  for (let i = 0; i < 30; i++) {
    try {
      await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`account ${id} did not appear`);
}

function account(id: string, kp: KeyPair) {
  return new Account(id, provider, kp.toString() as KeyPairString);
}

async function call(acc: Account, receiverId: string, method: string, args: object, deposit = 0n) {
  const out: any = await acc.signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall(method, args, 100n * TGAS, deposit)],
    waitUntil: 'FINAL',
  });
  if (!out.status || !('SuccessValue' in out.status)) throw new Error(`${method} failed: ${JSON.stringify(out.status)}`);
  return out.transaction.hash as string;
}

const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};

const root = `citario-${randomBytes(4).toString('hex')}.testnet`;
const rootKey = KeyPair.fromRandom('ed25519');
say(`1. faucet: creating ${root}`);
await faucetAccount(root, rootKey);
const rootAcc = account(root, rootKey);

const facilitatorKey = KeyPair.fromRandom('ed25519');
say(`2. deploy contract to ${root} and init (facilitator key ${facilitatorKey.getPublicKey().toString()})`);
const deployed: any = await rootAcc.signAndSendTransaction({
  receiverId: root,
  actions: [
    actions.deployContract(readFileSync(WASM)),
    actions.functionCall('new', { owner: root, facilitator_key: facilitatorKey.getPublicKey().toString() }, 100n * TGAS, 0n),
  ],
  waitUntil: 'FINAL',
});
if (!deployed.status || !('SuccessValue' in deployed.status)) throw new Error(`deploy failed: ${JSON.stringify(deployed.status)}`);
say(`   deploy tx ${deployed.transaction.hash}`);

async function sub(name: string, near: number) {
  const id = `${name}.${root}`;
  const kp = KeyPair.fromRandom('ed25519');
  const out: any = await rootAcc.signAndSendTransaction({
    receiverId: id,
    actions: [actions.createAccount(), actions.transfer(fromNear(near)), actions.addFullAccessKey(kp.getPublicKey())],
    waitUntil: 'FINAL',
  });
  if (!out.status || !('SuccessValue' in out.status)) throw new Error(`create ${id} failed`);
  say(`   created ${id} (${near} NEAR) tx ${out.transaction.hash}`);
  return { id, kp, acc: account(id, kp) };
}

say('3. create author and two reader agents');
const author = await sub('dr-sari', 0.5);
const scout = await sub('scout', 1.5);
const atlas = await sub('atlas', 1.5);

say('4. author encrypts the article for the facilitator and registers its hash');
const articleKeyHex = randomBytes(32).toString('hex');
process.env.ARTICLE_KEY_HEX = articleKeyHex;
cfg.articleKeyHex = articleKeyHex;
const { storeArticle } = await import('../packages/citario/src/text.ts');
const text = readFileSync(join(ROOT, 'demo/sample-article.md'), 'utf8');
const contentHash = storeArticle('coffee-shade', text);
if (contentHash !== sha256(text)) throw new Error('hash mismatch');
const regTx = await call(author.acc, root, 'register_article', {
  article_id: 'coffee-shade',
  title: 'Shade, Soil Moisture and Yield in Smallholder Coffee Plots of West Java',
  content_hash: contentHash,
  floor: fromNear(0.05).toString(),
  ceiling: fromNear(0.5).toString(),
});
say(`   register_article tx ${regTx} (floor 0.05, ceiling 0.5 NEAR)`);

say('5. owners fund the readers on Citario, then give each agent a key that can only call cite');
const readerKeys: Record<string, string> = {};
for (const r of [scout, atlas]) {
  const depTx = await call(r.acc, root, 'deposit', {}, fromNear(1));
  const fc = KeyPair.fromRandom('ed25519');
  const out: any = await r.acc.signAndSendTransaction({
    receiverId: r.id,
    actions: [actions.addFunctionCallAccessKey(fc.getPublicKey(), root, ['cite'], fromNear(0.25))],
    waitUntil: 'FINAL',
  });
  if (!out.status || !('SuccessValue' in out.status)) throw new Error('add key failed');
  readerKeys[r.id] = fc.toString();
  say(`   ${r.id}: deposit 1 NEAR tx ${depTx}; function-call key (cite only) tx ${out.transaction.hash}`);
}

// --- persist: .env keeps any existing NEARAI_* lines ---
const envPath = join(ROOT, '.env');
const keep = existsSync(envPath)
  ? readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((l) => /^(NEARAI_|NEAR_RPC_URL|NEAR_EXPLORER|FACILITATOR_URL|FACILITATOR_PORT)/.test(l))
  : [];
const env = [
  ...keep,
  `CITARIO_CONTRACT_ID=${root}`,
  `FACILITATOR_SECRET=${facilitatorKey.toString()}`,
  `ARTICLE_KEY_HEX=${articleKeyHex}`,
  `AUTHOR_ACCOUNT_ID=${author.id}`,
  `READER_ACCOUNT_ID=${scout.id}`,
  `READER_PRIVATE_KEY=${readerKeys[scout.id]}`,
  `READER2_ACCOUNT_ID=${atlas.id}`,
  `READER2_PRIVATE_KEY=${readerKeys[atlas.id]}`,
];
writeFileSync(envPath, env.join('\n') + '\n');
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(
  join(DATA_DIR, 'full-access-keys.json'),
  JSON.stringify({ [root]: rootKey.toString(), [author.id]: author.kp.toString(), [scout.id]: scout.kp.toString(), [atlas.id]: atlas.kp.toString() }, null, 2),
);
writeFileSync(join(DATA_DIR, 'setup.log'), log.join('\n') + '\n');
say(`\nDone. Contract ${root}. Keys in .env and data/ (gitignored). Next: pnpm run demo`);
