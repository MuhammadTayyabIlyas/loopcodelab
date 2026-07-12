#!/usr/bin/env node
// Answer ONE question with live-web, cited facts (Perplexity Sonar) — for agents mid-build.
// Usage: node gen-research.mjs "<question>" [out.md]
// Prints the cited answer to stdout (and saves to out.md when given).
// Exit: 0 answered | 2 error | 3 skipped (disabled / cap reached / no key → agent proceeds
// on its own knowledge and says so in progress.txt).
import { SONAR_MODEL, workerResearchMessages, parseSonar, groundingBlock } from './research.mjs';
import { readCounts, bumpCount, writeBinary } from './media-runtime.mjs';

const [question, outPath] = process.argv.slice(2);
if (!question) { console.error('usage: gen-research "<question>" [out.md]'); process.exit(2); }

const dir = process.env.RALPH_MEDIA_COUNT_DIR || process.cwd();
const enabled = process.env.RALPH_RESEARCH !== '0';
const cap = Number(process.env.RALPH_RESEARCH_CAP || 5);
const counts = await readCounts(dir);
if (!enabled) { console.log('[gen-research] skipped: research is disabled for this build.'); process.exit(3); }
if ((counts.research || 0) >= cap) { console.log(`[gen-research] skipped: research budget reached (${counts.research}/${cap}).`); process.exit(3); }

// No-spend stub harness: deterministic fixture.
if (process.env.RALPH_FORCE_TOOL) {
  const stub = `- stub research answer for: ${question.slice(0, 80)}\n\nSources:\n[1] https://example.com/stub`;
  if (outPath) await writeBinary(Buffer.from(stub + '\n'), outPath);
  await bumpCount(dir, 'research');
  console.log(stub); process.exit(0);
}

const key = process.env.RALPH_RESEARCH_KEY;
if (!key) { console.log('[gen-research] skipped: no research key connected — answer from your own knowledge and note the uncertainty.'); process.exit(3); }

try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SONAR_MODEL,
      messages: workerResearchMessages(question),
      max_tokens: 700,
      web_search_options: { search_context_size: 'low' },
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`[gen-research] API ${r.status}: ${JSON.stringify(data).slice(0, 200)}`); process.exit(2); }
  const { content, citations } = parseSonar(data);
  const block = groundingBlock(content, citations, 6000);
  if (!block) { console.error('[gen-research] empty answer'); process.exit(2); }
  if (outPath) await writeBinary(Buffer.from(block + '\n'), outPath);
  await bumpCount(dir, 'research');
  console.log(block);
} catch (e) { console.error(`[gen-research] ${e.message}`); process.exit(2); }
