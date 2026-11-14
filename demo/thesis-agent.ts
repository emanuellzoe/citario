// A small thesis-writing agent that uses Citario as its citation tool.
//
// A model on NEAR AI Cloud gets the same tools the MCP server exposes. It may
// only state numbers it bought through citario_buy_passage, and must cite them
// with the citation string Citario returns. This is how Citario "knows" a
// paper was used: the agent asked for it, paid the author, and got a receipt.
//
//   pnpm run thesis-agent ["<topic>"]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT } from '../packages/citario/src/config.ts';
import { agentOptionsFromEnv, CitarioAgent } from '../packages/citario/src/agent-tools.ts';

if (!cfg.nearAiKey) {
  console.error('Set NEARAI_API_KEY in .env: the writing model runs on NEAR AI Cloud.');
  process.exit(1);
}
const topic = process.argv[2] ?? 'Do shade trees protect smallholder coffee yields in West Java during drought years?';
const model = process.env.THESIS_MODEL ?? cfg.nearAiModel;
const agent = new CitarioAgent({ ...agentOptionsFromEnv(), maxSpendNear: Number(process.env.CITARIO_MAX_SPEND_NEAR ?? 0.6) });

const tools = [
  { name: 'citario_search', description: 'Find papers on Citario by words in the title.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'citario_quote', description: 'Get a price for the passage of a paper that answers a specific need. Free.', parameters: { type: 'object', properties: { article_id: { type: 'string' }, need: { type: 'string' } }, required: ['article_id', 'need'] } },
  { name: 'citario_buy_passage', description: 'Pay the author for a quoted passage; returns the passage and a citation string.', parameters: { type: 'object', properties: { quote_id: { type: 'string' } }, required: ['quote_id'] } },
].map((f) => ({ type: 'function', function: f }));

async function runTool(name: string, args: any) {
  try {
    if (name === 'citario_search') return await agent.searchArticles(args.query ?? '');
    if (name === 'citario_quote') return await agent.quote(args.article_id, args.need);
    if (name === 'citario_buy_passage') {
      const { receipt, ...r } = await agent.buyPassage(args.quote_id);
      return r;
    }
    return { error: `unknown tool ${name}` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};

const messages: any[] = [
  {
    role: 'system',
    content: [
      'You write one paragraph (120-160 words) of an MSc thesis literature review.',
      'You may only state a number or quote from a paper if you bought that passage with citario_buy_passage in this session.',
      'Workflow: citario_search, then citario_quote for each specific fact you need (ask for small, precise passages), then citario_buy_passage.',
      `Budget: ${agent.opts.maxSpendNear} NEAR in total; prefer two or three precise passages over one large one. Skip a quote whose already_bought is true, and do not buy a passage you already hold part of.`,
      'After the paragraph, add a "References" list with the exact citation strings Citario returned.',
    ].join('\n'),
  },
  { role: 'user', content: `Topic: ${topic}` },
];

say(`Thesis agent · model ${model} on NEAR AI Cloud · Citario at ${agent.opts.baseUrl} · agent ${agent.opts.accountId}`);
say(`Topic: ${topic}\n`);

for (let turn = 0; turn < 10; turn++) {
  const r = await fetch(`${cfg.nearAiBase}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.nearAiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`NEAR AI ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const msg = j.choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) {
    say('\n--- paragraph ---\n');
    say(msg.content);
    break;
  }
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments || '{}');
    const result: any = await runTool(call.function.name, args);
    const brief =
      call.function.name === 'citario_quote' && !result.error
        ? `${result.price_near} NEAR for ${result.sentences} sentence(s) from "${result.section}" (priced in TEE: ${result.priced_in_tee})`
        : call.function.name === 'citario_buy_passage' && !result.error
          ? `paid ${result.paid_near} NEAR → "${result.passage}"`
          : call.function.name === 'citario_search' && Array.isArray(result)
            ? result.map((a: any) => a.article_id).join(', ')
            : JSON.stringify(result).slice(0, 160);
    say(`→ ${call.function.name}(${JSON.stringify(args)})\n    ${brief}`);
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }
}

const s = await agent.spending();
say(`\n--- spent ${s.spent_this_session_near} NEAR of ${s.budget_near}; every purchase paid the author on chain ---`);
for (const p of s.purchases) say(`  ${p.kind}: ${p.what} · ${p.price} NEAR · tx ${p.tx}`);
writeFileSync(join(ROOT, 'demo/thesis-run.log'), log.join('\n') + '\n');
