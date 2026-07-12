#!/usr/bin/env node
// Direct (non-agentic) glm worker. GLM-5.1 via BytePlus is unreliable in the
// claude CLI's agentic loop (tool-use + completion signalling), so for a glm story
// we ask the model for the files in ONE call, then write + commit them here. We use
// the OpenAI-compatible BytePlus endpoint (`/api/coding/v3` + /chat/completions,
// Bearer auth) — more reliable than the Anthropic path and it supports
// response_format:json_object, so the model returns clean parseable JSON.
// Prints <promise>COMPLETE</promise> on success; exits non-zero otherwise (the
// orchestrator then retries / the master reviews).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const STORY = arg('story');
const DIR = arg('dir') || '.';
const KEY = process.env.GLM_API_KEY || '';
// OpenAI-compatible endpoint by default (more reliable than the Anthropic path).
const BASE = (process.env.GLM_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/coding/v3').replace(/\/$/, '');
const MODEL = process.env.GLM_MODEL || 'GLM-5.1';
const NOTE = process.env.RALPH_REVIEW_NOTE || '';
const die = (m) => { console.error('[glm-direct] ' + m); process.exit(2); };
if (!STORY || !KEY) die('need --story and GLM_API_KEY');
process.chdir(DIR);

const prd = JSON.parse(fs.readFileSync('prd.json', 'utf8'));
const story = (prd.stories || []).find((s) => s.id === STORY) || die('story not found: ' + STORY);

// Gather the current repo as context (skip heavy/binary; cap total size).
let files = [];
try { files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* none */ }
let ctx = '', budget = 60000;
for (const f of files) {
  if (/^node_modules\//.test(f) || /\.(png|jpe?g|gif|ico|webp|pdf|zip|lock)$/i.test(f)) continue;
  let c; try { c = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (c.length > 8000) c = c.slice(0, 8000) + '\n…(truncated)';
  const block = `\n--- ${f} ---\n${c}\n`;
  if (budget - block.length < 0) break;
  budget -= block.length; ctx += block;
}

const sys = 'You implement ONE user story in an existing repo. Reply with ONLY a JSON object '
  + '(no prose, no markdown fences): {"files":[{"path":"relative/path","content":"FULL file content"}]}. '
  + 'Always give the COMPLETE content of every file you create or replace (never a diff). Keep changes minimal '
  + 'and consistent with the existing code. No binary files.';
const user = `Story ${story.id}: ${story.title}\n${story.description || ''}\n`
  + `Acceptance criteria:\n${(story.acceptanceCriteria || []).map((a) => '- ' + a).join('\n')}\n`
  + (NOTE ? `\nReviewer note: ${NOTE}\n` : '')
  + `\nExisting files:\n${ctx || '(empty project)'}\n\nReturn the JSON now.`;

const res = await fetch(BASE + '/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: Number(process.env.GLM_MAX_TOKENS) || 16000, // room for reasoning + full files
    response_format: { type: 'json_object' }, // /v3 returns clean fence-free JSON
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
  }),
}).catch((e) => die('fetch failed: ' + e.message));
if (!res.ok) die('API HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 300));
const data = await res.json();
const text = data.choices?.[0]?.message?.content || '';

// Extract a balanced JSON object (tolerate fences / leaked tags / stray prose).
function extractJson(t) {
  const s = t.replace(/```json|```/g, '');
  const i = s.indexOf('{'); if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(i, j + 1);
  }
  return null;
}
const jsonStr = extractJson(text) || die('no JSON in model output: ' + text.slice(0, 200));
let out; try { out = JSON.parse(jsonStr); } catch (e) { die('bad JSON: ' + e.message); }
const outFiles = Array.isArray(out.files) ? out.files : [];
if (!outFiles.length) die('model returned no files');

const root = process.cwd();
let wrote = 0;
for (const f of outFiles) {
  if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
  const abs = path.resolve(root, f.path);
  if (abs !== root && !abs.startsWith(root + path.sep)) { console.error('skip unsafe path: ' + f.path); continue; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, f.content);
  wrote++;
}
if (!wrote) die('no valid files written');
execFileSync('git', ['add', '-A']);
try { execFileSync('git', ['commit', '-q', '-m', `feat: ${STORY} - ${story.title}`]); } catch { /* maybe no change */ }
console.log(`[glm-direct] wrote ${wrote} file(s) for ${STORY}`);
console.log('<promise>COMPLETE</promise>');
