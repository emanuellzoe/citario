// Citario facilitator: quote -> (reader pays on chain) -> deliver.
//
// Before payment a reader gets only the price, the passage size and the passage
// hash. The passage and the pricer's rationale are released only after the chain
// shows a `cite` for that quote by that reader at that price.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, actions, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { checkCiteTx, view, type Article, type Citation } from './chain.ts';
import { cfg, DATA_DIR, need, toNear } from './config.ts';
import { price, type Pricing } from './pricer.ts';
import { signQuote, facilitatorKey, type SignedQuote } from './quote.ts';
import { loadArticle, passageOf, sentences, sha256 } from './text.ts';

type Pending = { quote: SignedQuote; reader: string; pricing: Pricing; need: string; stripped: string[]; created_at: string };

const pending = new Map<string, Pending>();
const RECEIPTS = join(DATA_DIR, 'receipts');
const WEB_INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
mkdirSync(RECEIPTS, { recursive: true });
let lastAttestation: unknown = null;

// --- tiny rate limit: quotes cost inference and leak a little, so cap them ---
const hits = new Map<string, number[]>();
function limited(ip: string, max = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const h = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  h.push(now);
  hits.set(ip, h);
  return h.length > max;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function quote(body: any) {
  const { article_id, need: needText, reader } = body ?? {};
  if (typeof article_id !== 'string' || typeof needText !== 'string' || typeof reader !== 'string') {
    return [400, { error: 'need {article_id, need, reader}' }] as const;
  }
  const article = await view<Article | null>('get_article', { article_id });
  if (!article) return [404, { error: 'unknown article' }] as const;

  const text = loadArticle(article_id);
  if (sha256(text) !== article.content_hash) return [409, { error: 'stored text does not match the on-chain content_hash' }] as const;
  const all = sentences(text);
  const { pricing, stripped } = await price(all, needText, BigInt(article.floor), BigInt(article.ceiling));
  if (pricing.attestation) lastAttestation = { at: new Date().toISOString(), ...pricing.attestation };
  const [s, e] = pricing.span;
  const passage = passageOf(all, s, e);

  const q = signQuote(reader, {
    article_id,
    quote_id: randomBytes(12).toString('hex'),
    passage_hash: sha256(passage),
    price: pricing.price,
    expires_at_ns: (BigInt(Date.now() + cfg.quoteTtlMs) * 1_000_000n).toString(),
  });
  pending.set(q.quote_id, { quote: q, reader, pricing, need: needText, stripped, created_at: new Date().toISOString() });

  return [
    200,
    {
      quote: q,
      price_near: toNear(q.price),
      sentences: e - s + 1,
      words: passage.split(/\s+/).length,
      section: all[s].section,
      engine: pricing.engine,
      attested: pricing.attestation?.verified ?? false,
      clamped: pricing.clamped,
      stripped_from_need: stripped,
      expires_at: new Date(Number(BigInt(q.expires_at_ns) / 1_000_000n)).toISOString(),
      pay_with: { contract: need('contractId'), method: 'cite', args: { quote: q } },
      note: 'Passage and rationale are released by /deliver after the cite tx is final.',
    },
  ] as const;
}

async function deliver(body: any) {
  const { quote_id, tx_hash } = body ?? {};
  const p = typeof quote_id === 'string' ? pending.get(quote_id) : undefined;
  if (!p) return [404, { error: 'unknown or already delivered quote' }] as const;
  if (typeof tx_hash !== 'string') return [400, { error: 'need {quote_id, tx_hash}' }] as const;

  const txProblem = await checkCiteTx(tx_hash, p.reader);
  if (txProblem) return [402, { error: txProblem }] as const;
  const c = await view<Citation | null>('get_citation', { quote_id });
  if (!c) return [402, { error: 'no citation on chain for this quote yet' }] as const;
  if (c.reader !== p.reader) return [402, { error: 'paid by a different reader' }] as const;
  if (c.price !== p.quote.price) return [402, { error: 'paid price differs from quote' }] as const;
  if (c.passage_hash !== p.quote.passage_hash) return [402, { error: 'passage hash differs from quote' }] as const;

  const all = sentences(loadArticle(p.quote.article_id));
  const passage = passageOf(all, p.pricing.span[0], p.pricing.span[1]);
  if (sha256(passage) !== p.quote.passage_hash) return [500, { error: 'passage changed since quote' }] as const;

  const article = await view<Article>('get_article', { article_id: p.quote.article_id });
  const receipt = {
    version: 'citario-receipt/v1',
    contract: need('contractId'),
    network: 'testnet',
    article: { article_id: article.article_id, title: article.title, author: article.author, content_hash: article.content_hash },
    quote: p.quote,
    reader: p.reader,
    facilitator_public_key: facilitatorKey().getPublicKey().toString(),
    tx_hash,
    explorer: `${cfg.explorer}/txns/${tx_hash}`,
    citation: c,
    pricing: {
      engine: p.pricing.engine,
      span: p.pricing.span,
      model_price: p.pricing.model_price,
      final_price: p.pricing.price,
      clamped: p.pricing.clamped,
      rationale: p.pricing.rationale,
      stripped_from_need: p.stripped,
    },
    near_ai: p.pricing.attestation,
    passage_sha256: p.quote.passage_hash,
    issued_at: new Date().toISOString(),
  };
  writeFileSync(join(RECEIPTS, `${quote_id}.json`), JSON.stringify(receipt, null, 2));
  pending.delete(quote_id);
  return [200, { passage, receipt }] as const;
}

export function startFacilitator(port = cfg.port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true,
          contract: cfg.contractId,
          engine: cfg.nearAiKey ? `near-ai-cloud:${cfg.nearAiModel}` : 'local-fallback (attested: false)',
          facilitator_public_key: facilitatorKey().getPublicKey().toString(),
        });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(WEB_INDEX));
      }
      if (req.method === 'GET' && url.pathname === '/config') {
        return send(res, 200, {
          contract: cfg.contractId,
          rpcUrl: cfg.rpcUrl,
          explorer: cfg.explorer,
          engine: cfg.nearAiKey ? `NEAR AI Cloud TEE (${cfg.nearAiModel})` : 'local fallback (attested: false)',
          readers: [process.env.READER_ACCOUNT_ID, process.env.READER2_ACCOUNT_ID].filter(Boolean),
        });
      }
      if (req.method === 'GET' && url.pathname === '/receipt/latest') {
        // Public receipt only: the passage is never served publicly.
        const files = readdirSync(RECEIPTS).filter((f) => f.endsWith('.json'));
        if (!files.length) return send(res, 404, { error: 'no receipt yet' });
        const newest = files.map((f) => ({ f, t: statSync(join(RECEIPTS, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
        return send(res, 200, { receipt: JSON.parse(readFileSync(join(RECEIPTS, newest), 'utf8')) });
      }
      if (req.method === 'GET' && url.pathname === '/attestation') {
        return send(res, lastAttestation ? 200 : 404, lastAttestation ?? { error: 'no attested quote yet' });
      }
      const m = url.pathname.match(/^\/receipt\/([a-f0-9]{24})$/);
      if (req.method === 'GET' && m) {
        const f = join(RECEIPTS, `${m[1]}.json`);
        return existsSync(f) ? send(res, 200, JSON.parse(readFileSync(f, 'utf8'))) : send(res, 404, { error: 'no receipt' });
      }
      if (req.method === 'POST' && url.pathname === '/quote') {
        if (limited(req.socket.remoteAddress ?? '?')) return send(res, 429, { error: 'too many quotes' });
        const [status, body] = await quote(await readJson(req));
        return send(res, status, body);
      }
      if (req.method === 'POST' && url.pathname === '/demo/pay') {
        // Demo convenience for the web page: pays a quote with the reader agent's
        // function-call key from .env. Localhost only; a real agent pays itself.
        const ip = req.socket.remoteAddress ?? '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return send(res, 403, { error: 'demo pay is localhost only' });
        const { quote_id } = await readJson(req);
        const p = pending.get(quote_id);
        if (!p) return send(res, 404, { error: 'unknown or already delivered quote' });
        const keys: Record<string, string | undefined> = {
          [process.env.READER_ACCOUNT_ID ?? '-']: process.env.READER_PRIVATE_KEY,
          [process.env.READER2_ACCOUNT_ID ?? '-']: process.env.READER2_PRIVATE_KEY,
        };
        const key = keys[p.reader];
        if (!key) return send(res, 403, { error: `no demo key for ${p.reader}` });
        const acc = new Account(p.reader, new JsonRpcProvider({ url: cfg.rpcUrl }), key as KeyPairString);
        let txHash = '';
        try {
          const sent: any = await acc.signAndSendTransaction({
            receiverId: need('contractId'),
            actions: [actions.functionCall('cite', { quote: p.quote }, 100_000_000_000_000n, 0n)],
            waitUntil: 'FINAL',
          });
          txHash = sent.transaction?.hash;
        } catch (e) {
          return send(res, 402, { error: `cite rejected: ${String((e as Error).message).slice(0, 200)}` });
        }
        const [status, body] = await deliver({ quote_id, tx_hash: txHash });
        return send(res, status, { tx_hash: txHash, explorer: `${cfg.explorer}/txns/${txHash}`, ...body });
      }
      if (req.method === 'POST' && url.pathname === '/deliver') {
        const [status, body] = await deliver(await readJson(req));
        return send(res, status, body);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
  return new Promise<typeof server>((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFacilitator();
  const a = s.address();
  console.log(`citario facilitator on :${typeof a === 'object' && a ? a.port : cfg.port}`);
  console.log(`contract ${cfg.contractId}, engine ${cfg.nearAiKey ? cfg.nearAiModel : 'local-fallback (attested: false)'}`);
}
