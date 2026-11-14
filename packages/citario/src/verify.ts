// Verify a Citario receipt without trusting the facilitator.
//
//   pnpm verify <receipt.json> [passage.txt]
//
// Checks against the chain (testnet RPC), not against the facilitator.
import { existsSync, readFileSync } from 'node:fs';
import { verifyMessage } from 'ethers';
import { checkCiteTx, view, type Article, type Citation } from './chain.ts';
import { verifyQuote } from './quote.ts';
import { sha256 } from './text.ts';

export type Check = { name: string; ok: boolean | null; detail: string };

export async function verifyReceipt(receipt: any, passage?: string): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | null, detail = '') => checks.push({ name, ok, detail });
  const contract = receipt.contract;

  const onChainKey = await view<string>('get_facilitator_key', {}, contract);
  add('facilitator key in receipt = key registered in contract', onChainKey === receipt.facilitator_public_key, onChainKey);
  add('quote signed by that facilitator key', verifyQuote(contract, receipt.reader, receipt.quote, onChainKey));

  const txProblem = await checkCiteTx(receipt.tx_hash, receipt.reader).catch((e) => String(e));
  add('cite tx is final and succeeded on chain', txProblem === null, txProblem ?? receipt.tx_hash);

  const c = await view<Citation | null>('get_citation', { quote_id: receipt.quote.quote_id }, contract);
  add('citation stored on chain for this quote', !!c, c ? `block ${c.block_height}` : 'missing');
  if (c) {
    add('on-chain reader = receipt reader', c.reader === receipt.reader, c.reader);
    add('on-chain price = quoted price', c.price === receipt.quote.price, c.price);
    add('on-chain passage hash = quoted passage hash', c.passage_hash === receipt.quote.passage_hash, c.passage_hash);
  }
  const a = await view<Article | null>('get_article', { article_id: receipt.quote.article_id }, contract);
  if (a) {
    const p = BigInt(receipt.quote.price);
    add("price inside the author's current bounds", p >= BigInt(a.floor) && p <= BigInt(a.ceiling), `${a.floor}..${a.ceiling}`);
    add('article hash on chain = receipt', a.content_hash === receipt.article.content_hash, a.content_hash);
  }
  if (passage !== undefined) {
    add('sha256(passage) = passage hash', sha256(passage) === receipt.quote.passage_hash, sha256(passage));
  } else {
    add('passage hash', null, 'no passage file given; skipped');
  }

  const ai = receipt.near_ai;
  if (!ai) {
    add('NEAR AI Cloud attestation', false, 'attested: false — priced by the local fallback, no TEE signature');
  } else {
    let recovered = '';
    try {
      recovered = verifyMessage(ai.signed_text, ai.signature).toLowerCase();
    } catch {}
    add('NEAR AI response signature recovers to signing_address', recovered !== '' && recovered === ai.signing_address.toLowerCase(), `${ai.signature_kind} ${recovered}`);
    add('signed text binds request and response hashes', ai.signed_text.endsWith(`${ai.request_sha256}:${ai.response_sha256}`), ai.model);
    for (const ch of ai.checks ?? []) add(`facilitator preflight: ${ch.name}`, ch.ok, ch.detail);
    add('independent check', null, 'run nearai-cloud-verifier or cloud.near.ai/verify for the full TDX/GPU quote');
  }
  return checks;
}

export function printChecks(checks: Check[]) {
  for (const c of checks) {
    const mark = c.ok === null ? '·' : c.ok ? '✓' : '✗';
    console.log(`  ${mark} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, passageFile] = process.argv.slice(2);
  if (!file) {
    console.error('usage: pnpm verify <receipt.json> [passage.txt]');
    process.exit(2);
  }
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  const pf = passageFile ?? file.replace(/\.json$/, '.passage.txt');
  const passage = existsSync(pf) ? readFileSync(pf, 'utf8') : undefined;
  const checks = await verifyReceipt(receipt, passage);
  printChecks(checks);
  const hard = checks.filter((c) => c.ok === false && !c.name.startsWith('NEAR AI Cloud attestation'));
  process.exit(hard.length ? 1 : 0);
}
