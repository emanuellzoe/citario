// Citario facilitator: quote -> (reader pays on chain) -> deliver.
//
// Before payment a reader gets only the price, the passage size and the passage
// hash. The passage and the pricer's rationale are released only after the chain
// shows a `cite` for that quote by that reader at that price.
//
// Stateless: /quote returns a ticket (the quote plus the span and pricing
// evidence) MACed with a key derived from the facilitator secret. /deliver takes
// the ticket back. Nothing has to survive between requests, so the same handler
// runs as a local Node server or as a Vercel Function.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, actions, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { checkCiteTx, view, type Article, type Citation } from './chain.ts';
import { cfg, DATA_DIR, need, toNear } from './config.ts';
import { price, type Pricing } from './pricer.ts';
import { facilitatorKey, signQuote, type SignedQuote } from './quote.ts';
import { loadArticle, passageOf, sentences, sha256 } from './text.ts';

type Ticket = { quote: SignedQuote; reader: string; pricing: Pricing; need: string; stripped: string[] };

const RECEIPTS = join(DATA_DIR, 'receipts');
const WEB_INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
let lastAttestation: unknown = null;

// ---------- tickets ----------
function ticketKey(): Buffer {
  return createHash('sha256').update(`citario-ticket:v1:${need('facilitatorSecret')}`).digest();
}
function sealTicket(t: Ticket): string {
  const body = Buffer.from(JSON.stringify(t)).toString('base64url');
  const mac = createHmac('sha256', ticketKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function openTicket(ticket: unknown): Ticket | null {
  if (typeof ticket !== 'string' || ticket.length > 60_000) return null;
  const [body, mac] = ticket.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', ticketKey()).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString()) as Ticket;
}

// ---------- demo agents (keys the server may pay with) ----------
function demoKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  const pairs: [string | undefined, string | undefined][] = [
    [process.env.DEMO_READER_ACCOUNT_ID, process.env.DEMO_READER_PRIVATE_KEY],
    [process.env.READER_ACCOUNT_ID, process.env.READER_PRIVATE_KEY],
    [process.env.READER2_ACCOUNT_ID, process.env.READER2_PRIVATE_KEY],
  ];
  for (const [id, key] of pairs) if (id && key) out[id] = key;
  return out;
}
function demoReaders(): string[] {
  return Object.keys(demoKeys());
}

// ---------- best-effort rate limit (per instance) ----------
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  h.push(now);
  hits.set(key, h);
  return h.length > max;
}
function clientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for'];
  return (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0].trim() || req.socket.remoteAddress || '?';
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const pre = (req as any).body; // Vercel may have parsed it already
  if (pre && typeof pre === 'object') return pre;
  if (typeof pre === 'string') return pre ? JSON.parse(pre) : {};
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 80_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function saveReceipt(id: string, receipt: unknown) {
  try {
    mkdirSync(RECEIPTS, { recursive: true });
    writeFileSync(join(RECEIPTS, `${id}.json`), JSON.stringify(receipt, null, 2));
  } catch {
    // read-only filesystem (serverless): the receipt is returned to the reader anyway
  }
}

async function quote(body: any) {
  const { article_id, need: needText, reader } = body ?? {};
  if (typeof article_id !== 'string' || typeof needText !== 'string' || typeof reader !== 'string') {
    return [400, { error: 'need {article_id, need, reader}' }] as const;
  }
  if (!/^[a-z0-9._-]{2,64}$/.test(reader)) return [400, { error: 'reader must be a NEAR account id' }] as const;
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
  const ticket = sealTicket({ quote: q, reader, pricing, need: needText, stripped });

  return [
    200,
    {
      quote: q,
      ticket,
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
      note: 'Pay with cite, then POST /deliver {ticket, tx_hash}. Passage and rationale are released after the tx is final.',
    },
  ] as const;
}

async function deliver(body: any) {
  const { ticket, tx_hash } = body ?? {};
  const t = openTicket(ticket);
  if (!t) return [400, { error: 'missing or forged ticket' }] as const;
  if (typeof tx_hash !== 'string') return [400, { error: 'need {ticket, tx_hash}' }] as const;
  const quoteId = t.quote.quote_id;

  const txProblem = await checkCiteTx(tx_hash, t.reader);
  if (txProblem) return [402, { error: txProblem }] as const;
  const c = await view<Citation | null>('get_citation', { quote_id: quoteId });
  if (!c) return [402, { error: 'no citation on chain for this quote yet' }] as const;
  if (c.reader !== t.reader) return [402, { error: 'paid by a different reader' }] as const;
  if (c.price !== t.quote.price) return [402, { error: 'paid price differs from quote' }] as const;
  if (c.passage_hash !== t.quote.passage_hash) return [402, { error: 'passage hash differs from quote' }] as const;

  const all = sentences(loadArticle(t.quote.article_id));
  const passage = passageOf(all, t.pricing.span[0], t.pricing.span[1]);
  if (sha256(passage) !== t.quote.passage_hash) return [500, { error: 'passage changed since quote' }] as const;

  const article = await view<Article>('get_article', { article_id: t.quote.article_id });
  const receipt = {
    version: 'citario-receipt/v1',
    contract: need('contractId'),
    network: 'testnet',
    article: { article_id: article.article_id, title: article.title, author: article.author, content_hash: article.content_hash },
    quote: t.quote,
    reader: t.reader,
    facilitator_public_key: facilitatorKey().getPublicKey().toString(),
    tx_hash,
    explorer: `${cfg.explorer}/txns/${tx_hash}`,
    citation: c,
    pricing: {
      engine: t.pricing.engine,
      need: t.need,
      span: t.pricing.span,
      model_price: t.pricing.model_price,
      final_price: t.pricing.price,
      clamped: t.pricing.clamped,
      rationale: t.pricing.rationale,
      stripped_from_need: t.stripped,
    },
    near_ai: t.pricing.attestation,
    passage_sha256: t.quote.passage_hash,
    issued_at: new Date().toISOString(),
  };
  saveReceipt(quoteId, receipt);
  return [200, { passage, receipt }] as const;
}

/** Pays a quote with a demo agent's function-call key (the agent can only call `cite`). */
async function tryPay(body: any, ip: string) {
  const t = openTicket(body?.ticket);
  if (!t) return [400, { error: 'missing or forged ticket' }] as const;
  const key = demoKeys()[t.reader];
  if (!key) return [403, { error: `${t.reader} is not a demo agent; pay with your own wallet` }] as const;
  if (limited(`pay:${ip}`, Number(process.env.DEMO_PAY_PER_HOUR ?? 6), 3_600_000)) {
    return [429, { error: 'demo agent limit reached for this hour; connect a testnet wallet to keep going' }] as const;
  }
  const acc = new Account(t.reader, new JsonRpcProvider({ url: cfg.rpcUrl }), key as KeyPairString);
  let txHash = '';
  try {
    const sent: any = await acc.signAndSendTransaction({
      receiverId: need('contractId'),
      actions: [actions.functionCall('cite', { quote: t.quote }, 100_000_000_000_000n, 0n)],
      waitUntil: 'FINAL',
    });
    txHash = sent.transaction?.hash;
  } catch (e) {
    const msg = String((e as Error).message);
    const why = msg.match(/reader balance too low|quote already used|quote expired|price outside[^"]*/)?.[0] ?? msg.slice(0, 200);
    return [402, { error: `cite rejected: ${why}` }] as const;
  }
  const [status, out] = await deliver({ ticket: body.ticket, tx_hash: txHash });
  return [status, { tx_hash: txHash, explorer: `${cfg.explorer}/txns/${txHash}`, ...out }] as const;
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/api(?=\/)/, '');
    const ip = clientIp(req);
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, {
        ok: true,
        contract: cfg.contractId,
        engine: cfg.nearAiKey ? `near-ai-cloud:${cfg.nearAiModel}` : 'local-fallback (attested: false)',
        facilitator_public_key: facilitatorKey().getPublicKey().toString(),
      });
    }
    if (req.method === 'GET' && (path === '/' || path === '/index.html') && existsSync(WEB_INDEX)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(WEB_INDEX));
    }
    if (req.method === 'GET' && path === '/config') {
      return send(res, 200, {
        contract: cfg.contractId,
        rpcUrl: cfg.rpcUrl,
        explorer: cfg.explorer,
        network: 'testnet',
        engine: cfg.nearAiKey ? `NEAR AI Cloud TEE (${cfg.nearAiModel})` : 'local fallback (attested: false)',
        demoReaders: demoReaders(),
      });
    }
    if (req.method === 'GET' && path === '/receipt/latest') {
      // Public receipt only (no passage). Local runs only; serverless has no disk.
      const files = existsSync(RECEIPTS) ? readdirSync(RECEIPTS).filter((f) => f.endsWith('.json')) : [];
      if (!files.length) return send(res, 404, { error: 'no receipt yet' });
      const newest = files.map((f) => ({ f, t: statSync(join(RECEIPTS, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
      return send(res, 200, { receipt: JSON.parse(readFileSync(join(RECEIPTS, newest), 'utf8')) });
    }
    if (req.method === 'GET' && path === '/attestation') {
      return send(res, lastAttestation ? 200 : 404, lastAttestation ?? { error: 'no attested quote on this instance yet' });
    }
    const m = path.match(/^\/receipt\/([a-f0-9]{24})$/);
    if (req.method === 'GET' && m) {
      const f = join(RECEIPTS, `${m[1]}.json`);
      return existsSync(f) ? send(res, 200, JSON.parse(readFileSync(f, 'utf8'))) : send(res, 404, { error: 'no receipt' });
    }
    if (req.method === 'POST' && path === '/quote') {
      if (limited(`quote:${ip}`, Number(process.env.QUOTES_PER_HOUR ?? 30), 3_600_000)) return send(res, 429, { error: 'too many quotes from this address; try again later' });
      const [status, body] = await quote(await readJson(req));
      return send(res, status, body);
    }
    if (req.method === 'POST' && (path === '/try/pay' || path === '/demo/pay')) {
      const [status, body] = await tryPay(await readJson(req), ip);
      return send(res, status, body);
    }
    if (req.method === 'POST' && path === '/deliver') {
      const [status, body] = await deliver(await readJson(req));
      return send(res, status, body);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
}

export function startFacilitator(port = cfg.port) {
  const server = createServer(handle);
  return new Promise<typeof server>((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFacilitator();
  const a = s.address();
  console.log(`citario facilitator on :${typeof a === 'object' && a ? a.port : cfg.port}`);
  console.log(`contract ${cfg.contractId}, engine ${cfg.nearAiKey ? cfg.nearAiModel : 'local-fallback (attested: false)'}`);
}
