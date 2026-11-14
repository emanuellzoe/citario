// Reader agent: ask -> quote -> pay with a function-call key -> deliver.
//
//   pnpm reader <article_id> "<need>" [--max <near>]
//
// The agent's key can only call `cite` on the Citario contract and cannot attach
// a deposit, so it spends from a balance its owner funded with `deposit`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Account, actions, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { cfg, DATA_DIR, fromNear, need, ROOT, toNear } from './config.ts';
import { view } from './chain.ts';

export type AskResult = { status: 'delivered' | 'declined' | 'failed'; quote?: any; passage?: string; receipt?: any; tx_hash?: string; error?: string };

async function post(path: string, body: unknown) {
  const r = await fetch(`${cfg.facilitatorUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}

export async function ask(opts: {
  readerId: string;
  readerKey: string;
  articleId: string;
  need: string;
  maxNear?: number;
  log?: (s: string) => void;
}): Promise<AskResult> {
  const log = opts.log ?? console.log;
  const q = await post('/quote', { article_id: opts.articleId, need: opts.need, reader: opts.readerId });
  if (q.status !== 200) return { status: 'failed', error: `quote ${q.status}: ${q.body.error}` };
  const qb = q.body;
  log(`  quote ${qb.quote.quote_id}: ${qb.price_near} NEAR for ${qb.sentences} sentence(s) from "${qb.section}" [engine ${qb.engine}, attested ${qb.attested}${qb.clamped ? `, clamped to ${qb.clamped}` : ''}]`);
  if (qb.stripped_from_need?.length) log(`  stripped from need: ${JSON.stringify(qb.stripped_from_need)}`);

  if (opts.maxNear !== undefined && BigInt(qb.quote.price) > fromNear(opts.maxNear)) {
    log(`  declined: over budget of ${opts.maxNear} NEAR`);
    return { status: 'declined', quote: qb };
  }

  const account = new Account(opts.readerId, new JsonRpcProvider({ url: cfg.rpcUrl }), opts.readerKey as KeyPairString);
  const sent: any = await account.signAndSendTransaction({
    receiverId: need('contractId'),
    actions: [actions.functionCall('cite', { quote: qb.quote }, 100_000_000_000_000n, 0n)],
    waitUntil: 'FINAL',
  });
  const txHash: string = sent.transaction?.hash ?? sent.transaction_outcome?.id;
  if (!sent.status || !('SuccessValue' in sent.status)) {
    return { status: 'failed', quote: qb, tx_hash: txHash, error: `cite failed: ${JSON.stringify(sent.status)}` };
  }
  log(`  paid: cite tx ${txHash}`);
  log(`        ${cfg.explorer}/txns/${txHash}`);

  const d = await post('/deliver', { quote_id: qb.quote.quote_id, tx_hash: txHash });
  if (d.status !== 200) return { status: 'failed', quote: qb, tx_hash: txHash, error: `deliver ${d.status}: ${d.body.error}` };
  mkdirSync(join(DATA_DIR, 'receipts-reader'), { recursive: true });
  const file = join(DATA_DIR, 'receipts-reader', `${qb.quote.quote_id}.json`);
  writeFileSync(file, JSON.stringify(d.body.receipt, null, 2));
  writeFileSync(file.replace(/\.json$/, '.passage.txt'), d.body.passage);
  log(`  receipt saved: ${relative(ROOT, file)}`);
  return { status: 'delivered', quote: qb, passage: d.body.passage, receipt: d.body.receipt, tx_hash: txHash };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const maxIdx = args.indexOf('--max');
  const maxNear = maxIdx >= 0 ? Number(args.splice(maxIdx, 2)[1]) : undefined;
  const [articleId, needText] = args;
  if (!articleId || !needText) {
    console.error('usage: pnpm reader <article_id> "<need>" [--max <near>]');
    process.exit(2);
  }
  const readerId = process.env.READER_ACCOUNT_ID ?? '';
  const readerKey = process.env.READER_PRIVATE_KEY ?? '';
  if (!readerId || !readerKey) throw new Error('set READER_ACCOUNT_ID and READER_PRIVATE_KEY (run `pnpm run setup:testnet`)');
  const bal = await view<string>('reader_balance', { reader: readerId });
  console.log(`${readerId} balance on Citario: ${toNear(bal)} NEAR`);
  const r = await ask({ readerId, readerKey, articleId, need: needText, maxNear });
  if (r.passage) console.log(`\nPASSAGE\n${r.passage}\n`);
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
}
