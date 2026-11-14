// Loads .env from the repo root (if present) and exposes typed settings.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const DATA_DIR = join(ROOT, 'data');

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const cfg = {
  rpcUrl: opt('NEAR_RPC_URL', 'https://test.rpc.fastnear.com'),
  explorer: opt('NEAR_EXPLORER', 'https://testnet.nearblocks.io'),
  contractId: opt('CITARIO_CONTRACT_ID'),
  facilitatorUrl: opt('FACILITATOR_URL', 'http://localhost:8787'),
  port: Number(opt('FACILITATOR_PORT', '8787')),
  facilitatorSecret: opt('FACILITATOR_SECRET'),
  articleKeyHex: opt('ARTICLE_KEY_HEX'),
  nearAiKey: opt('NEARAI_API_KEY'),
  nearAiBase: opt('NEARAI_BASE_URL', 'https://cloud-api.near.ai/v1'),
  nearAiModel: opt('NEARAI_MODEL', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'),
  quoteTtlMs: 10 * 60 * 1000,
};

export function need(name: keyof typeof cfg): string {
  const v = cfg[name];
  if (v === '' || v === undefined) {
    throw new Error(`missing setting ${String(name)}; run \`pnpm run setup:testnet\` or fill .env (see .env.example)`);
  }
  return String(v);
}

export const YOCTO = 10n ** 24n;
export function toNear(yocto: bigint | string): string {
  const y = BigInt(yocto);
  const whole = y / YOCTO;
  const frac = (y % YOCTO).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
export function fromNear(near: number): bigint {
  return BigInt(Math.round(near * 1e6)) * 10n ** 18n;
}
