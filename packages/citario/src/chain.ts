// Minimal NEAR JSON-RPC client: contract views and transaction status.
import { cfg, need } from './config.ts';

let rpcId = 0;
export async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(cfg.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    const body: any = await res.json();
    if (body.error) {
      const msg = JSON.stringify(body.error.data ?? body.error.cause ?? body.error);
      throw new Error(`rpc ${method}: ${msg}`);
    }
    return body.result as T;
  }
}

export async function view<T = any>(method: string, args: object = {}, contractId = need('contractId')): Promise<T> {
  const r = await rpc<{ result: number[] }>('query', {
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

export type Article = {
  article_id: string;
  author: string;
  content_hash: string;
  title: string;
  floor: string;
  ceiling: string;
  citations: number;
  earned: string;
};

export type Citation = {
  quote_id: string;
  article_id: string;
  reader: string;
  passage_hash: string;
  price: string;
  block_height: string;
  timestamp_ns: string;
};

/** Returns null when the tx succeeded; otherwise a reason it does not count. */
export async function checkCiteTx(txHash: string, reader: string): Promise<string | null> {
  let tx: any;
  try {
    tx = await rpc('tx', { tx_hash: txHash, sender_account_id: reader, wait_until: 'FINAL' });
  } catch (e) {
    return `tx not found for ${reader}: ${(e as Error).message}`;
  }
  if (tx.transaction?.receiver_id !== need('contractId')) return 'tx was not sent to the Citario contract';
  const fc = tx.transaction?.actions?.find((a: any) => a.FunctionCall)?.FunctionCall;
  if (fc?.method_name !== 'cite') return 'tx did not call cite';
  if (!tx.status || !('SuccessValue' in tx.status)) return `tx failed: ${JSON.stringify(tx.status)}`;
  return null;
}
