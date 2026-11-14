// What an AI agent needs to use Citario: find papers, get a price, pay, get the
// passage with a citation it can prove, or pay a citation fee to any DOI.
// Shared by the MCP server (mcp.ts) and the sample thesis agent.
//
// The agent account holds a function-call key that can only call cite,
// cite_fee and cite_doi on the Citario contract; spending also stops at a
// per-session budget enforced here.
import { Account, actions, JsonRpcProvider, type KeyPairString } from 'near-api-js';

const YOCTO = 10n ** 24n;
const toNear = (y: bigint | string) => {
  const b = BigInt(y);
  const f = (b % YOCTO).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '');
  return f ? `${b / YOCTO}.${f}` : `${b / YOCTO}`;
};
const fromNear = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;

export type AgentOptions = { baseUrl: string; accountId: string; privateKey: string; maxSpendNear: number };

export function agentOptionsFromEnv(): AgentOptions {
  const e = process.env;
  const accountId = e.CITARIO_AGENT_ACCOUNT_ID ?? e.DEMO_READER_ACCOUNT_ID ?? e.READER_ACCOUNT_ID ?? '';
  const privateKey = e.CITARIO_AGENT_PRIVATE_KEY ?? e.DEMO_READER_PRIVATE_KEY ?? e.READER_PRIVATE_KEY ?? '';
  return {
    baseUrl: (e.CITARIO_URL ?? 'https://citario.vercel.app').replace(/\/$/, ''),
    accountId,
    privateKey,
    maxSpendNear: Number(e.CITARIO_MAX_SPEND_NEAR ?? 1),
  };
}

export class CitarioAgent {
  private cfg: any = null;
  private tickets = new Map<string, any>();
  private bought = new Set<string>();
  spent = 0n;
  readonly budget: bigint;
  readonly purchases: { kind: 'passage' | 'doi_fee'; what: string; price: string; tx: string }[] = [];

  readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.budget = fromNear(opts.maxSpendNear);
  }

  private async http(path: string, body?: unknown) {
    const r = await fetch(`${this.opts.baseUrl}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `${path}: HTTP ${r.status}`);
    return j;
  }

  async config() {
    this.cfg ??= await this.http('/config');
    return this.cfg;
  }

  private async view(method: string, args: object) {
    const c = await this.config();
    const r = await fetch(c.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: c.contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
    });
    const j: any = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error.cause ?? j.error));
    return JSON.parse(Buffer.from(j.result.result).toString());
  }

  private requireKey() {
    if (!this.opts.accountId || !this.opts.privateKey) throw new Error('no agent account: set CITARIO_AGENT_ACCOUNT_ID and CITARIO_AGENT_PRIVATE_KEY (a key limited to cite, cite_fee, cite_doi)');
  }

  private async send(method: string, args: object): Promise<string> {
    this.requireKey();
    const c = await this.config();
    const acc = new Account(this.opts.accountId, new JsonRpcProvider({ url: c.rpcUrl }), this.opts.privateKey as KeyPairString);
    try {
      const out: any = await acc.signAndSendTransaction({ receiverId: c.contract, actions: [actions.functionCall(method, args, 100_000_000_000_000n, 0n)], waitUntil: 'FINAL' });
      return out.transaction.hash;
    } catch (e) {
      const m = String((e as Error).message);
      throw new Error(`${method} rejected by the contract: ${m.match(/reader balance too low[^"]*|quote [a-z ]+|price outside[^"]*|not a DOI[^"]*|amount below[^"]*|pending verification[^"]*|not for sale[^"]*/)?.[0] ?? m.slice(0, 200)}`);
    }
  }

  private checkBudget(price: bigint) {
    if (this.spent + price > this.budget) {
      throw new Error(`over budget: this would make ${toNear(this.spent + price)} NEAR spent this session, the limit is ${toNear(this.budget)} NEAR`);
    }
  }

  /** Registered papers, optionally filtered by words in the title or DOI. */
  async searchArticles(query = '') {
    const arts: any[] = await this.view('list_articles', { limit: 100 });
    const words = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    return arts
      .map((a) => ({ a, score: words.filter((w) => `${a.title} ${a.doi ?? ''}`.toLowerCase().includes(w)).length }))
      .filter((x) => !words.length || x.score > 0)
      .sort((x, y) => y.score - x.score)
      .map(({ a }) => ({
        article_id: a.article_id,
        title: a.title,
        author: a.author,
        doi: a.doi,
        license: a.license,
        can_buy_passages: a.mode === 'Paid' && a.active,
        status: a.active ? 'active' : 'pending_verification',
        price_range_near: `${toNear(a.floor)}-${toNear(a.ceiling)}`,
        citations: a.citations,
      }));
  }

  async lookupDoi(doi: string) {
    const j = await this.http(`/doi?doi=${encodeURIComponent(doi)}`);
    return {
      doi: j.doi,
      status: j.status,
      title: j.crossref?.title,
      authors: (j.crossref?.authors ?? []).slice(0, 8).map((a: any) => a.name),
      license: j.license?.license,
      text_for_sale: j.article?.mode === 'Paid' && j.article?.active,
      article_id: j.chain?.article_id ?? null,
      escrow_near: toNear(j.chain?.escrow ?? 0),
      how_to_pay: j.how_to_pay,
    };
  }

  /** Asks the TEE pricer for the passage that answers `need`. Nothing is paid yet. */
  async quote(articleId: string, need: string) {
    this.requireKey();
    const q = await this.http('/quote', { article_id: articleId, need, reader: this.opts.accountId });
    this.tickets.set(q.quote.quote_id, q);
    return {
      quote_id: q.quote.quote_id,
      passage_hash: q.quote.passage_hash,
      already_bought: this.bought.has(q.quote.passage_hash),
      price_near: q.price_near,
      sentences: q.sentences,
      words: q.words,
      section: q.section,
      priced_in_tee: q.attested,
      clamped_to: q.clamped,
      stripped_from_need: q.stripped_from_need,
      expires_at: q.expires_at,
      budget_left_near: toNear(this.budget - this.spent),
    };
  }

  /** Pays a quote on chain, then fetches the passage and a citation with its proof. */
  async buyPassage(quoteId: string) {
    const q = this.tickets.get(quoteId);
    if (!q) throw new Error('unknown quote_id; call quote first (quotes live 10 minutes)');
    const price = BigInt(q.quote.price);
    this.checkBudget(price);
    const tx = await this.send('cite', { quote: q.quote });
    this.spent += price;
    this.tickets.delete(quoteId);
    this.bought.add(q.quote.passage_hash);
    let d: any = null;
    for (let i = 0; i < 6 && !d; i++) {
      try {
        d = await this.http('/deliver', { ticket: q.ticket, tx_hash: tx });
      } catch (e) {
        if (i === 5) throw e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const r = d.receipt;
    this.purchases.push({ kind: 'passage', what: `${r.article.title} (${q.sentences} sentences)`, price: q.price_near, tx });
    return {
      passage: d.passage,
      citation: `${r.article.author.split('.')[0]}, "${r.article.title}". Passage bought via Citario (quote ${quoteId}, testnet tx ${tx}, passage sha256 ${r.quote.passage_hash.slice(0, 16)}…).`,
      verify_url: `${this.opts.baseUrl}/#verify`,
      explorer: r.explorer,
      paid_near: q.price_near,
      priced_in_tee: !!r.near_ai?.verified,
      budget_left_near: toNear(this.budget - this.spent),
      receipt: r,
    };
  }

  /** A citation fee to any DOI; held in escrow if no verified author holds it yet. */
  async citeDoi(doi: string, amountNear?: number) {
    const c = await this.view('get_config', {});
    const min = BigInt(c.min_cite_fee);
    const amount = amountNear ? (fromNear(amountNear) > min ? fromNear(amountNear) : min) : min;
    this.checkBudget(amount);
    const tx = await this.send('cite_doi', { doi, amount: amount.toString() });
    this.spent += amount;
    const info: any = await this.view('get_doi', { doi });
    this.purchases.push({ kind: 'doi_fee', what: info.doi, price: toNear(amount), tx });
    return {
      doi: info.doi,
      paid_near: toNear(amount),
      went_to: info.owner ? `verified author ${info.owner}` : 'escrow (no verified author yet; refundable to you after the escrow period)',
      escrow_near: toNear(info.escrow),
      tx,
      explorer: `${(await this.config()).explorer}/txns/${tx}`,
      budget_left_near: toNear(this.budget - this.spent),
    };
  }

  async spending() {
    const bal = this.opts.accountId ? await this.view('reader_balance', { reader: this.opts.accountId }) : '0';
    return { agent: this.opts.accountId, spent_this_session_near: toNear(this.spent), budget_near: toNear(this.budget), citario_balance_near: toNear(bal), purchases: this.purchases };
  }
}
