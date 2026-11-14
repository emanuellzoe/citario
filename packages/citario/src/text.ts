// Article storage (AES-256-GCM at rest) and sentence splitting.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DATA_DIR, need } from './config.ts';

export const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

function key(): Buffer {
  const k = Buffer.from(need('articleKeyHex'), 'hex');
  if (k.length !== 32) throw new Error('ARTICLE_KEY_HEX must be 32 bytes hex');
  return k;
}

export function storeArticle(articleId: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  mkdirSync(join(DATA_DIR, 'articles'), { recursive: true });
  writeFileSync(join(DATA_DIR, 'articles', `${articleId}.enc`), Buffer.concat([iv, c.getAuthTag(), ct]));
  return sha256(plaintext);
}

/** Decrypts in memory only; the plaintext is never written back to disk. */
export function loadArticle(articleId: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(articleId)) throw new Error('bad article id');
  const env = process.env.ARTICLES_DIR;
  const dir = env ? (isAbsolute(env) ? env : join(process.cwd(), env)) : join(DATA_DIR, 'articles');
  const buf = readFileSync(join(dir, `${articleId}.enc`));
  const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export type Sentence = { i: number; section: string; text: string; words: number };

export function sentences(markdown: string): Sentence[] {
  const out: Sentence[] = [];
  let section = 'Front matter';
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      section = h[1].replace(/^\d+[.)]?\s*/, '');
      continue;
    }
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9("])/)) {
      const text = s.trim();
      if (text) out.push({ i: out.length, section, text, words: text.split(/\s+/).length });
    }
  }
  return out;
}

/** The exact passage string for a span; its sha256 is what goes on chain. */
export function passageOf(all: Sentence[], start: number, end: number): string {
  return all
    .slice(start, end + 1)
    .map((s) => s.text)
    .join(' ');
}
