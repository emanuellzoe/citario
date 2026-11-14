// Bundles the facilitator for the Vercel Function (api/index.ts imports the result).
import { build } from 'esbuild';

await build({
  entryPoints: ['packages/citario/src/facilitator.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  outfile: 'api/_lib/facilitator.mjs',
  logLevel: 'warning',
});
console.log('built api/_lib/facilitator.mjs');
