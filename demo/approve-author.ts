// Verifier step: bind a DOI to an author account after checking authorship.
// Shows the Crossref author list (with ORCIDs) and the pending registration,
// then calls approve_author with the contract owner's key, which activates the
// registration and releases any escrowed citation fees for that DOI.
//
//   pnpm run approve-author <doi> <author.testnet> [--yes]
//   pnpm run approve-author --reject <article_id> "<reason>"
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, actions, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { cfg, DATA_DIR, need, toNear } from '../packages/citario/src/config.ts';
import { view } from '../packages/citario/src/chain.ts';
import { crossrefWork, normalizeDoi } from '../packages/citario/src/crossref.ts';

const args = process.argv.slice(2);
const contract = need('contractId');
const keys = JSON.parse(readFileSync(join(DATA_DIR, 'full-access-keys.json'), 'utf8'));
const owner = new Account(contract, new JsonRpcProvider({ url: cfg.rpcUrl }), keys[contract] as KeyPairString);

async function call(method: string, a: object) {
  const out: any = await owner.signAndSendTransaction({ receiverId: contract, actions: [actions.functionCall(method, a, 50_000_000_000_000n, 0n)], waitUntil: 'FINAL' });
  if (!out.status || !('SuccessValue' in out.status)) throw new Error(`${method} failed: ${JSON.stringify(out.status)}`);
  return out.transaction.hash as string;
}

if (args[0] === '--reject') {
  const [, articleId, reason = 'authorship not confirmed'] = args;
  console.log(`reject_registration ${articleId}: tx ${await call('reject_registration', { article_id: articleId, reason })}`);
  process.exit(0);
}

const [doiIn, author] = args;
if (!doiIn || !author) {
  console.error('usage: pnpm run approve-author <doi> <author.testnet> [--yes] | --reject <article_id> "<reason>"');
  process.exit(2);
}
const doi = normalizeDoi(doiIn);
const [work, chain] = await Promise.all([crossrefWork(doi), view<any>('get_doi', { doi })]);
console.log(`DOI ${doi}`);
console.log(work.found ? `  Crossref: "${work.title}" (${work.publisher})` : '  Crossref: no record (test prefix, preprint or self-published)');
for (const a of work.authors) console.log(`    author: ${a.name}${a.orcid ? `  ORCID ${a.orcid}` : ''}`);
console.log(`  on chain: owner ${chain.owner ?? '-'}, article ${chain.article_id ?? '-'}, escrow ${toNear(chain.escrow)} NEAR from ${chain.fee_citations} fee(s)`);
if (chain.article_id) {
  const a = await view<any>('get_article', { article_id: chain.article_id });
  console.log(`  registration by ${a.author}: "${a.title}" license ${a.license}, mode ${a.mode}, active ${a.active}`);
}
if (!args.includes('--yes')) {
  console.log(`\nCheck that ${author} is one of the authors above (ORCID, email on the paper, institutional page), then re-run with --yes.`);
  process.exit(0);
}
console.log(`approve_author: tx ${await call('approve_author', { doi, author })}`);
const after = await view<any>('get_doi', { doi });
console.log(`  owner ${after.owner}, escrow now ${toNear(after.escrow)} NEAR; author balance ${toNear(await view('author_balance', { author }))} NEAR`);
