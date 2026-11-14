// Citario MCP server (stdio). Lets Claude, Cursor or any MCP client find papers,
// get a TEE-priced quote, pay the author on NEAR, and receive the passage with a
// citation it can prove; or pay a citation fee to any DOI.
//
//   node packages/citario/src/mcp.ts
//
// Env: CITARIO_URL (default https://citario.vercel.app), CITARIO_AGENT_ACCOUNT_ID,
// CITARIO_AGENT_PRIVATE_KEY (function-call key: cite, cite_fee, cite_doi),
// CITARIO_MAX_SPEND_NEAR (per-session budget, default 1).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { agentOptionsFromEnv, CitarioAgent } from './agent-tools.ts';

// Local convenience: pick up the repo .env (an agent key from `pnpm run fund:demo-agent`).
const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
if (existsSync(envFile) && !process.env.CITARIO_AGENT_ACCOUNT_ID) process.loadEnvFile(envFile);

const agent = new CitarioAgent(agentOptionsFromEnv());
const server = new McpServer(
  { name: 'citario', version: '0.2.0' },
  {
    instructions:
      'Citario sells passages of academic papers to agents, priced inside a TEE, and pays the authors on NEAR (testnet). ' +
      'When you need a fact, number or quote from a paper: citario_search, then citario_quote (free, shows the price), then citario_buy_passage. ' +
      'Only quote or cite text you received from citario_buy_passage, and include its citation string. ' +
      'For a paper Citario does not sell, you may pay its authors a citation fee with citario_cite_doi. Stay within the budget.',
  },
);

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const safe = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return text(await fn(a));
  } catch (e) {
    return { ...text({ error: (e as Error).message }), isError: true };
  }
};

server.registerTool(
  'citario_search',
  {
    title: 'Search papers on Citario',
    description: 'List papers registered on Citario, filtered by words in the title or DOI. Shows whether passages can be bought and the price range.',
    inputSchema: { query: z.string().optional().describe('words to look for, e.g. "coffee shade drought"') },
    annotations: { readOnlyHint: true },
  },
  safe(({ query }: { query?: string }) => agent.searchArticles(query ?? '')),
);

server.registerTool(
  'citario_lookup_doi',
  {
    title: 'Look up a DOI',
    description: 'Crossref metadata, license, whether the text is for sale on Citario, and any citation fees waiting in escrow for its authors.',
    inputSchema: { doi: z.string().describe('a DOI such as 10.1371/journal.pone.0185809') },
    annotations: { readOnlyHint: true },
  },
  safe(({ doi }: { doi: string }) => agent.lookupDoi(doi)),
);

server.registerTool(
  'citario_quote',
  {
    title: 'Get a price for a passage',
    description: 'A model in a TEE reads the paper and your need, picks the smallest passage that answers it and prices it. Free; nothing is paid. The passage itself is not shown until you buy.',
    inputSchema: {
      article_id: z.string().describe('from citario_search'),
      need: z.string().describe('what you need from the paper, e.g. "the sample size" or "yield loss in the drought year"'),
    },
    annotations: { readOnlyHint: true },
  },
  safe(({ article_id, need }: { article_id: string; need: string }) => agent.quote(article_id, need)),
);

server.registerTool(
  'citario_buy_passage',
  {
    title: 'Buy a quoted passage',
    description: 'Pays the quoted price on NEAR testnet (the money goes to the author), then returns the passage and a citation string with its on-chain proof. Spends from the agent budget.',
    inputSchema: { quote_id: z.string().describe('from citario_quote') },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  safe(async ({ quote_id }: { quote_id: string }) => {
    const r = await agent.buyPassage(quote_id);
    const { receipt, ...rest } = r;
    return { ...rest, receipt_quote_id: receipt.quote.quote_id };
  }),
);

server.registerTool(
  'citario_cite_doi',
  {
    title: 'Pay a citation fee to a DOI',
    description: 'Pays the authors of any DOI a citation fee (minimum 0.01 NEAR on testnet). No text is delivered. If no verified author holds the DOI yet, the fee waits in escrow and is refundable after the escrow period.',
    inputSchema: { doi: z.string(), amount_near: z.number().positive().optional() },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  safe(({ doi, amount_near }: { doi: string; amount_near?: number }) => agent.citeDoi(doi, amount_near)),
);

server.registerTool(
  'citario_spending',
  {
    title: 'Spending so far',
    description: 'What this session has bought, the budget left and the agent balance on Citario.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(() => agent.spending()),
);

await server.connect(new StdioServerTransport());
