// The facilitator's quote signature: the exact message the contract verifies.
import { KeyPair, PublicKey, type KeyPairString } from 'near-api-js';
import { need } from './config.ts';

export type SignedQuote = {
  article_id: string;
  quote_id: string;
  passage_hash: string;
  price: string;
  expires_at_ns: string;
  signature: string; // base64 ed25519
};

export function quoteMessage(contract: string, reader: string, q: Omit<SignedQuote, 'signature'>): string {
  return `citario-quote:v1:${contract}:${reader}:${q.article_id}:${q.quote_id}:${q.passage_hash}:${q.price}:${q.expires_at_ns}`;
}

export function facilitatorKey(): KeyPair {
  return KeyPair.fromString(need('facilitatorSecret') as KeyPairString);
}

export function signQuote(reader: string, q: Omit<SignedQuote, 'signature'>): SignedQuote {
  const msg = new TextEncoder().encode(quoteMessage(need('contractId'), reader, q));
  const { signature } = facilitatorKey().sign(msg);
  return { ...q, signature: Buffer.from(signature).toString('base64') };
}

export function verifyQuote(contract: string, reader: string, q: SignedQuote, publicKey: string): boolean {
  const msg = new TextEncoder().encode(quoteMessage(contract, reader, q));
  return PublicKey.fromString(publicKey).verify(msg, Buffer.from(q.signature, 'base64'));
}
