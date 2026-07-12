// server/llm.mjs — one-shot LLM call plumbing for the planner personas:
// OpenAI-compatible chat, Anthropic-style chat, the tenant claude-CLI path,
// and callPlanner's provider fallback chain. No orchestrator state here.
import path from 'node:path';
import fs from 'node:fs/promises';
import * as saasStore from '../saas/store.mjs';
import { execFileAsync } from './config.mjs';
import {
  getSecrets, openaiKey, openaiModel, qwenKey, qwenBaseUrl, qwenModel,
} from './secrets.mjs';
import { claudePlanOf, shq } from './agents.mjs';

// Minimal OpenAI-compatible Chat Completions call (no SDK) — OpenAI and
// DashScope/qwen both speak this. Returns the assistant content string (qwen also
// returns reasoning_content, which we ignore); throws the API error on non-2xx.
export async function callChat({ baseUrl, key, model, messages, json }) {
  const body = { model, messages };
  if (json) body.response_format = { type: 'json_object' };
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `LLM HTTP ${resp.status}`);
  return data.choices?.[0]?.message?.content || '';
}
export async function callOpenAI(messages, { json = false } = {}) {
  const key = openaiKey();
  if (!key) throw new Error('OpenAI API key not configured (~/.webtmux/secrets.json).');
  return callChat({ baseUrl: 'https://api.openai.com/v1', key, model: openaiModel(), messages, json });
}
// Anthropic Messages call — api.anthropic.com or any Anthropic-compatible coding
// plan endpoint (Z.ai/Kimi/DeepSeek/MiniMax/OpenRouter…). JSON mode is emulated by
// instruction (extractJson tolerates prose); authVar picks Bearer vs x-api-key.
export async function callAnthropicChat({ baseUrl, key, authVar, model, messages, json }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  if (json && rest.length) {
    const last = rest[rest.length - 1];
    rest[rest.length - 1] = { ...last, content: `${last.content}\n\nRespond with ONLY a valid JSON object — no prose, no code fences.` };
  }
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (authVar === 'ANTHROPIC_AUTH_TOKEN') headers.Authorization = `Bearer ${key}`;
  else headers['x-api-key'] = key;
  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, max_tokens: 16384, system: system || undefined, messages: rest }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `LLM HTTP ${resp.status}`);
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}
// A tenant whose ONLY credential is a Claude subscription token can't call the raw
// Messages API (OAuth tokens are CLI-scoped) — plan via a one-shot non-interactive
// `claude -p` AS the tenant, on their subscription. The token goes in a transient
// 0660 script under the tenant's projects dir (NOT argv — sudo logs argv).
export async function planViaClaudeCli(tenantCtx, token, messages) {
  const prompt = messages.map((m) => m.content).join('\n\n');
  const script = path.join(tenantCtx.projectsRoot, `.planner-${Date.now()}.sh`);
  await fs.writeFile(script,
    `#!/bin/bash\ncd "$HOME"\nexport PATH="/usr/local/bin:$PATH" CLAUDE_CODE_OAUTH_TOKEN=${shq(token)}\nexec claude -p --output-format text\n`,
    { mode: 0o660 });
  try {
    const argv = tenantCtx.wrap(['bash', script]);
    const p = execFileAsync(argv[0], argv.slice(1), { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    p.child.stdin.end(prompt);
    const { stdout } = await p;
    return stdout;
  } finally { await fs.rm(script, { force: true }).catch(() => {}); }
}
// Multi-tenant: plan on the TENANT's own credential so planning runs on the user's
// account too (BYO end-to-end). Preference: OpenAI key → qwen key → Anthropic key →
// coding-plan endpoint → Claude subscription (CLI one-shot). null = no usable
// credential, caller falls back to the platform planner.
export const PLANNER_CLAUDE_MODEL = 'claude-sonnet-4-6';
export async function tenantPlannerCall(tenant, messages, { json = false } = {}) {
  const get = (p) => { try { return saasStore.getProviderKey(tenant.id, p); } catch { return null; } };
  const via = (v) => console.log(`[ralph] planner: tenant ${tenant.slug} credential (${v})`);
  const openai = get('openai');
  if (openai) { via('openai key'); return callChat({ baseUrl: 'https://api.openai.com/v1', key: openai, model: openaiModel(), messages, json }); }
  const qwen = get('qwen');
  if (qwen) { via('qwen key'); return callChat({ baseUrl: qwenBaseUrl(), key: qwen, model: qwenModel(), messages, json }); }
  const anthropic = get('anthropic');
  if (anthropic) { via('anthropic key'); return callAnthropicChat({ baseUrl: 'https://api.anthropic.com', key: anthropic, authVar: 'ANTHROPIC_API_KEY', model: PLANNER_CLAUDE_MODEL, messages, json }); }
  const plan = claudePlanOf(get);
  if (plan) { via(`coding plan ${plan.baseUrl}`); return callAnthropicChat({ baseUrl: plan.baseUrl, key: plan.key, authVar: plan.authVar, model: plan.model || PLANNER_CLAUDE_MODEL, messages, json }); }
  const oauth = get('claude-oauth');
  if (oauth) { via('claude subscription (CLI)'); return planViaClaudeCli(tenant, oauth, messages); }
  return null;
}
// PRD-creation calls (planner + clarify): the tenant's own credential when one is
// configured, then the platform qwen deep-thinking model, then OpenAI — so a
// tenant-credential outage never blocks planning.
export async function callPlanner(messages, { json = false, tenant = null } = {}) {
  if (tenant) {
    try {
      const out = await tenantPlannerCall(tenant, messages, { json });
      if (out != null) return out;
    } catch (e) { console.error(`[ralph] tenant planner failed (${e.message}); falling back to platform planner`); }
  }
  if (qwenKey()) {
    try { return await callChat({ baseUrl: qwenBaseUrl(), key: qwenKey(), model: qwenModel(), messages, json }); }
    catch (e) { if (!openaiKey()) throw e; console.error(`[ralph] qwen planner failed (${e.message}); falling back to OpenAI`); }
  }
  return callOpenAI(messages, { json });
}
// Tolerant JSON extraction — strips ``` fences / stray prose a model may add even
// in JSON mode. Returns null if nothing parses.
export function extractJson(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(s); } catch { /* try slicing an object out */ }
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch { /* give up */ } }
  return null;
}