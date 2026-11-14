// Vercel Function entry: the same handler the local facilitator server uses,
// bundled by `pnpm run build:api` (esbuild) so the TypeScript sources ship.
import type { IncomingMessage, ServerResponse } from 'node:http';

let loaded: Promise<{ handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    // @ts-ignore generated at build time
    loaded ??= import('./_lib/facilitator.mjs');
    const { handle } = await loaded;
    return await handle(req, res);
  } catch (e) {
    loaded = null;
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: `facilitator failed to load: ${(e as Error).message}` }));
  }
}
