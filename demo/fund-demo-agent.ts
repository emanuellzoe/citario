// Creates the shared demo agent used by the hosted page's "Try with the demo
// agent" button: a fresh faucet account that funds its own Citario balance and
// keeps only a function-call key limited to `cite`. Its Citario balance is the
// hard cap on what visitors can spend. Writes DEMO_READER_* to .env.
//
//   pnpm run fund:demo-agent [near]     # default 8 NEAR on Citario
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { cfg, fromNear, need, ROOT } from '../packages/citario/src/config.ts';
import { rpc } from '../packages/citario/src/chain.ts';

const amount = Number(process.argv[2] ?? 8);
const contract = need('contractId');
const id = `citario-demo-${randomBytes(3).toString('hex')}.testnet`;
const full = KeyPair.fromRandom('ed25519');

const r = await fetch('https://helper.nearprotocol.com/account', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newAccountId: id, newAccountPublicKey: full.getPublicKey().toString() }),
});
if (!r.ok) throw new Error(`faucet ${r.status}: ${(await r.text()).slice(0, 200)}`);
for (let i = 0; ; i++) {
  try {
    await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
    break;
  } catch {
    if (i > 30) throw new Error(`${id} did not appear`);
    await new Promise((res) => setTimeout(res, 1000));
  }
}
console.log(`created ${id}`);

const acc = new Account(id, new JsonRpcProvider({ url: cfg.rpcUrl }), full.toString() as KeyPairString);
const fc = KeyPair.fromRandom('ed25519');
const out: any = await acc.signAndSendTransaction({
  receiverId: contract,
  actions: [actions.functionCall('deposit', {}, 30_000_000_000_000n, fromNear(amount))],
  waitUntil: 'FINAL',
});
if (!out.status || !('SuccessValue' in out.status)) throw new Error(`deposit failed: ${JSON.stringify(out.status)}`);
console.log(`deposited ${amount} NEAR on ${contract}: tx ${out.transaction.hash}`);
const k: any = await acc.signAndSendTransaction({
  receiverId: id,
  actions: [actions.addFunctionCallAccessKey(fc.getPublicKey(), contract, ['cite', 'cite_fee', 'cite_doi'], fromNear(1))],
  waitUntil: 'FINAL',
});
if (!k.status || !('SuccessValue' in k.status)) throw new Error('add key failed');
console.log(`function-call key (cite, cite_fee, cite_doi only): tx ${k.transaction.hash}`);

const envPath = join(ROOT, '.env');
const lines = (existsSync(envPath) ? readFileSync(envPath, 'utf8') : '').split('\n').filter((l) => l && !l.startsWith('DEMO_READER_'));
lines.push(`DEMO_READER_ACCOUNT_ID=${id}`, `DEMO_READER_PRIVATE_KEY=${fc.toString()}`);
writeFileSync(envPath, lines.join('\n') + '\n');
console.log('DEMO_READER_* written to .env (the full-access key is discarded; the account can only cite).');
