# Token-Plan Multi-Model + Media Generation — Design Spec

**Date:** 2026-07-01
**Status:** Approved (design, iterating); pending implementation plan
**Author:** webtmux maintainer session

## Goal

Two initiatives sharing a common credential + generation layer, integrated into Ralph builds:

- **Part A — Multi-model coding agents:** let a build's `claude` agent run on any registered **text**
  model — token-plan (qwen / glm / kimi / deepseek / minimax, billed to `qwenApiKey`) **and OpenRouter**
  (any model) — chosen per build.
- **Parts C/D/E — Media generation in deliverables:** when a build produces a deliverable that benefits
  from media, agents can generate:
  - **C. Images** (token plan, reuse `qwenApiKey`) — `qwen-image-2.0(-pro)`, `wan2.7-image(-pro)`.
  - **D. Video** (BytePlus ModelArk / Seedance, **new named credential `ark`**) — hero + product-demo clips.
  - **E. Audio** — **music** (Suno via sunoapi.org, **new `suno`**) for app/game sound + demo music, and
    **voiceover/speech** (ElevenLabs, **new `elevenlabs`**) for narration.

**Three new named credentials** (per decision): `ark` (video), `suno` (music), `elevenlabs` (voiceover).
**Image reuses** `qwenApiKey`; **OpenRouter** reuses its existing coding-plan credential.

Non-goals (this project): image→video, Hyper3D, image *editing* (Seedream i2i), and any always-on media
generation. Media is opt-in per media type with a cap. Video/audio reuse the proven async patterns from
`video.tayyabcheema.com` — they are **not** re-probed live here (video/audio generation costs real credits).

## Verified facts

Token plan **must** use the token-plan host — the `sk-sp-…` key 401s on `dashscope-intl.aliyuncs.com`.
(Text + image rows live-probed 2026-07-01; ARK/Suno rows are the proven config from the video project.)

| Purpose | Base URL | Protocol / status |
|---|---|---|
| Text agents (A) | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` | Anthropic `/v1/messages`; 200 all brands, Bearer + x-api-key ✓ |
| Text/image (planner, image) | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | OpenAI `/chat/completions`; 200 ✓ |
| Text (OpenRouter) | `https://openrouter.ai/api` | Anthropic-compat coding-plan preset (existing) |
| Video (D) | `https://ark.ap-southeast.bytepluses.com/api/v3` | ModelArk async tasks (proven) |
| Music (E) | `https://api.sunoapi.org` | Suno generate + record-info poll (proven) |
| Voiceover (E) | `https://api.elevenlabs.io` | ElevenLabs TTS, sync binary MP3, `xi-api-key` |

**Text models:** qwen3.7-max/plus, qwen3.6-plus/flash, glm-5.2/5.1/5, kimi-k2.7-code/k2.6/k2.5,
deepseek-v4-pro/flash/v3.2, MiniMax-M2.5. **Image models:** qwen-image-2.0(-pro), wan2.7-image(-pro).
**Video models (Seedance):** dreamina-seedance-2-0(-fast)-260128, seedance-1-0-pro-250528.
**Audio (Suno):** V4 / V4.5 / V5.

**Proven call shapes** — reference `/home/tmuxweb/projects/video/backend/app/services/generation_service.py`:
- **Image** (sync): `POST /compatible-mode/v1/chat/completions`, body
  `{model, messages:[{role:"user", content:[{type:"text", text:prompt}]}]}`; image URL is inside
  response `output` (walk for first `https…{.png,.jpg,.jpeg,.webp}`). ~8 s.
- **Video** (async): `POST {ark}/contents/generations/tasks` (`{model, content:[{type:text,text}], ratio,
  duration, watermark}`) → `{id}`; poll `GET {ark}/contents/generations/tasks/{id}` → `status` +
  `content.video_url`. Bearer auth.
- **Audio** (async): `POST {suno}/api/v1/generate` (`{prompt, model:V4_5, customMode, instrumental,
  callBackUrl?}`) → `data.taskId`; poll `GET {suno}/api/v1/generate/record-info?taskId=` → status
  PENDING→…→SUCCESS, audio in `response.sunoData[].audioUrl`. Bearer auth. Credit check:
  `GET {suno}/api/v1/generate/credit`.

---

## Architecture — extensible provider registry (core)

The number of providers **will grow** — this is designed data-first so adding a vendor is a registry
entry, not new plumbing. One declarative registry drives credentials, the Settings/Admin cards, the
model pickers, and generation dispatch.

**`ralph/providers.mjs` — `PROVIDER_REGISTRY`** (pure, tested). Each entry:
```
{ id: 'tokenplan',                     // credential/vault id
  label: 'Alibaba Token Plan',
  kinds: ['text','image'],             // what it can produce
  protocol: 'openai',                  // adapter: openai | anthropic | ark-async | suno-async | elevenlabs-tts
  baseUrl: '…/compatible-mode/v1',     // (+ optional altBaseUrl per kind, e.g. anthropic for text)
  credential: { source: 'qwenApiKey' },// reuse secrets key, OR named vault provider
  models: [{ id:'qwen3.7-max', kinds:['text'] }, { id:'qwen-image-2.0', kinds:['image'] }, …] }
```
- **Adapters** are the only code that knows a wire protocol. Five cover today's needs
  (`openai` text/image-chat, `anthropic` text incl. OpenRouter, `ark-async` video, `suno-async` music,
  `elevenlabs-tts` voiceover). **Adding a provider on an existing protocol = one registry entry, zero
  new code.** A genuinely new protocol = one new adapter + entries.
- **Everything else is generated from the registry:** `VAULT_PROVIDERS` (∪ registry credential ids),
  the Settings/Admin credential cards, `key-test` probes (each entry names its probe), the New Build
  text-model dropdown (`kinds∋text`), and the media helpers' dispatch (by `protocol`).
- **Credential source per entry:** `reuse` an existing secrets key (e.g. `qwenApiKey`) or a **named vault
  provider** the user connects. So the 3 new named credentials (`ark`, `suno`, `elevenlabs`) are simply
  registry entries with `credential:{source:'vault'}`; the next provider is the same shape.

Seed entries (extensible):
- `tokenplan` — text + image, `openai`/`anthropic` adapters, **reuse `qwenApiKey`**.
- `openrouter` — text, `anthropic` adapter, existing vault key (already a `CLAUDE_PLAN_PRESET`).
- `ark` — video, `ark-async`, **new vault key**.
- `suno` — music, `suno-async`, **new vault key**.
- `elevenlabs` — voiceover/speech, `elevenlabs-tts`, **new vault key**.

More can be added later (another image/video/audio/text vendor) without touching adapters.

## Shared foundation — credentials & config

- **Reuse** `secrets.json` `qwenApiKey` (`sk-sp-…`) as the token-plan key for Part A + image gen.
- **Three new named credentials** in `VAULT_PROVIDERS` (+ single-tenant `secrets.json` fallback, mirroring
  `firebaseConfig()` etc.):
  - `ark` → `arkKey()` (env `WEBTMUX_ARK_KEY` → `secrets.arkApiKey`), base `arkBaseUrl()`
    (default `https://ark.ap-southeast.bytepluses.com/api/v3`).
  - `suno` → `sunoKey()` (env `WEBTMUX_SUNO_KEY` → `secrets.sunoApiKey`), base `sunoBaseUrl()`
    (default `https://api.sunoapi.org`).
  - `elevenlabs` → `elevenLabsKey()` (env `WEBTMUX_ELEVENLABS_KEY` → `secrets.elevenLabsApiKey`), base
    `https://api.elevenlabs.io` (auth header `xi-api-key`); optional `secrets.elevenLabsVoiceId`/`Model`.
  UI: a **"Media generation" card group** (generated from the registry) in Settings (`web/`) + the
  `public/` Settings dialog + Admin; each with a Test button (`key-test.mjs`: ark → auth GET on
  `{base}/…`; suno → `GET /api/v1/generate/credit`, surfaces remaining credits; elevenlabs →
  `GET /v1/user` or `/v1/voices` with `xi-api-key`).
- **Part A preset base:** `tokenPlanAnthropicBase()` (env `WEBTMUX_QWEN_ANTHROPIC_BASE` →
  `secrets.qwenAnthropicBaseUrl` → default `…/apps/anthropic`).
- **Per-media caps/toggles** (`enabled`, `cap`), admin/secrets defaults, env-overridable, per-build
  overridable in the New Build dialog. Defaults reflect cost:
  | media | default enabled | default cap | env |
  |---|---|---|---|
  | image | **on** | 8 | `WEBTMUX_RALPH_IMAGE_CAP`, `WEBTMUX_RALPH_IMAGES` |
  | video | **off** | 2 | `WEBTMUX_RALPH_VIDEO_CAP`, `WEBTMUX_RALPH_VIDEO` |
  | audio | **off** | 3 | `WEBTMUX_RALPH_AUDIO_CAP`, `WEBTMUX_RALPH_AUDIO` |
- Multitenant: prefer the tenant's own vault key per credential; else fall back to `secrets.json`.
- **`gitInitProject`** ignore list gains nothing new (keys are env-injected, never written to the repo),
  but generated media downloads to `assets/` and IS committed (public URLs already expired-safe).

---

## Part A — Multi-model coding agents

### Approach (chosen)
One **Anthropic-protocol coding-plan preset** driving the reliable, master-capable `claude` CLI — reuses
the whole coding-plan path; no new agent or CLI quirks. (Rejected: qwen/codex OpenAI-compat CLIs — less
reliable, qwen can't be master; a bespoke `alibaba` agent — reinvents `CLAUDE_PLAN_PRESETS`.)

### Components
1. **`CLAUDE_PLAN_PRESETS` (`server.js`):** add
   `tokenplan: { label:'Alibaba Token Plan (Qwen/GLM/Kimi/DeepSeek/MiniMax)', baseUrl: tokenPlanAnthropicBase(),
   authVar:'ANTHROPIC_AUTH_TOKEN', model:'qwen3.7-max' }`. The claude branch of `tenantAgentCreds` already
   sets `ANTHROPIC_BASE_URL` + auth + `ANTHROPIC_MODEL` (per-run `run.model` wins); `agentHasCodingPlan`
   already suppresses a fighting `--model`.
2. **Key resolution:** `tokenplan` preset key = tenant vault `tokenplan` → else `secrets.qwenApiKey`
   (single-admin works with no re-paste). `VAULT_PROVIDERS` gains `tokenplan` (optional connect).
3. **Model list:** curated `TOKEN_PLAN_MODELS` (text models) exposed on `/api/keys` (like `planPresets`)
   for both UIs' New Build model dropdown. `validModelId` already accepts the ids; `/api/ralph/start`
   already threads `model` → `ANTHROPIC_MODEL`.
4. **Settings connect flow:** add the preset to `web/src/pages/Settings.jsx` + `public/` Settings dialog;
   `key-test` via `buildPlanProbe` on `<base>/v1/models` (confirm `/apps/anthropic/v1/models` = 200
   during build; else a 1-token `/v1/messages` ping).
5. **New Build model picker:** `web/` new-build flow + `public/js/dashboard.js` show `TOKEN_PLAN_MODELS`
   when the connected claude credential is the `tokenplan` preset; selection posts `model` to `/start`.

### Testing (A)
Unit: preset shape + model-list sanitization. Manual: connect preset, stub build picking `glm-5.2` /
`deepseek-v4-pro`, confirm `ANTHROPIC_MODEL` in session env; one real 1-story build on `kimi-k2.7-code`.

---

## Parts C/D/E — Media generation subsystem

### Approach (chosen)
A small **shared media-generation core** with three thin vendored CLI helpers the worker invokes
(agent-agnostic, like skills; credential + config injected via env; no MCP). Mirrors the proven
video-project functions. Each helper is stub-aware and enforces its media's cap/toggle.

- **`ralph/media-gen.mjs`** (pure, tested core): payload builders (`buildImagePayload`, `buildVideoPayload`,
  `buildMusicPayload`), response parsers (`findImageUrl`, `parseVideoTask`, `parseMusicTask` — ports of the
  Python originals), and `capState(count, cap, enabled)`.
- **`ralph/gen-image.mjs`** `"<prompt>" <out.png>` — sync token-plan `/chat/completions`; download URL.
- **`ralph/gen-video.mjs`** `"<prompt>" <out.mp4> [--duration N] [--ratio 16:9]` — ARK create-task then
  block-poll (bounded, e.g. ≤10 min) → download `video_url`.
- **`ralph/gen-audio.mjs`** `"<prompt>" <out.mp3> --type music|voiceover [--instrumental] [--voice ID]` —
  dispatches by `--type`: **music** → Suno (`suno-async`, poll record-info → download `audioUrl`);
  **voiceover** → ElevenLabs (`elevenlabs-tts`: sync `POST /v1/text-to-speech/{voice_id}` with header
  `xi-api-key`, returns binary MP3 written straight to `<out.mp3>`; default `voice_id`/`model_id`,
  `GET /v1/voices` to list).

Common behavior for all three:
- Enforce the per-build cap via a shared counter file `.ralph/media-count.json` (`{image,video,audio}`);
  refuse past cap or when disabled with **guidance, never a hard build failure** (fall back to
  placeholder/stock/omit).
- Env: `RALPH_<MEDIA>_KEY/_BASE/_MODEL/_CAP` + `RALPH_<MEDIA>` (0 disables). Keys: image=`qwenApiKey`,
  video=`arkKey()`, music=`sunoKey()`, voiceover=`elevenLabsKey()`. (The `audio` cap covers music +
  voiceover combined.)
- **Stub-aware:** `RALPH_FORCE_TOOL` set → write a deterministic placeholder file + bump counter, no
  network → the no-spend e2e harness stays green.
- Downloads land in `assets/` (or format-appropriate: `public/`, `web/assets/`), committed with the build.

### Wiring into builds
- **Env injection (`ralphEnvPrefix`):** for **visual/media output** runs (`VISUAL_OUTPUT` + web-app,
  slides, pptx, flutter-app, docs) set the `RALPH_*` vars for each enabled media type, plus
  `RALPH_GEN_IMAGE/VIDEO/AUDIO` = the helper paths.
- **Skill (`ralph/skills/media/SKILL.md`, extends today's `imagery`):** tells any agent how/when to call
  the helpers, the per-build budgets, and the fallback order (brand assets → generate → stock →
  placeholder/omit). Audio guidance covers app/game sound + product-demo music; video covers hero/demo
  clips. `writeRalphBrief` injects it (and the effective caps) for media-capable output formats.
- **Cap/toggle UI:** New Build dialog (both UIs) gets a compact "Media" section — per type: on/off + max-N
  (defaults 8/2/3). Posted as `media:{image:{enabled,cap}, video:{…}, audio:{…}}` → `run.media`;
  `ralphEnvPrefix` reads it; admin/secrets set the defaults.

### Testing (C/D/E)
Unit: `ralph/media-gen.test.mjs` — every payload shape, each parser over the real response structures,
cap/disabled logic. Stub e2e: a media-capable stub build writes placeholder image/video/audio under caps;
`docs/ops/flutter-stub-e2e.sh` still passes. Post-deploy: one real image (already curl-verified), one
short real video, one short real audio track (guarded by low caps + explicit enable).

---

## Rollout / ops
- `server.js` edits → `node --check` → `systemctl restart webtmux` (safe; `killmode.conf`).
- `public/` edits → **bump `VERSION` in `public/sw.js`**. `web/` edits → `cd web && npm run build`.
- New pure modules ship with `*.test.mjs`; run `node --test ralph/*.test.mjs`.
- `CLAUDE.md`: document the token-plan preset (agents/credential section) + the media-generation
  subsystem (new short section). Manual-checkpoint repo — commit only when asked.

## Phasing (for the implementation plan)
0. **Provider registry + shared config** — `ralph/providers.mjs` (`PROVIDER_REGISTRY` + adapters map),
   `tokenPlanAnthropicBase`, `ark`/`suno`/`elevenlabs` resolvers + registry-derived `VAULT_PROVIDERS`,
   media caps/toggles, tenant→secrets fallback.
1. **Part A backend** — `tokenplan` + `openrouter` registry text entries + `TOKEN_PLAN_MODELS` + key-test.
2. **Part A UI** — web/ + public/ Settings preset + New Build text-model picker.
3. **Media core** — `ralph/media-gen.mjs` + `media-gen.test.mjs` (payloads/parsers/cap for all adapters).
4. **Media helpers** — `gen-image/gen-video/gen-audio.mjs` (stub-aware, cap-enforcing) + env injection.
5. **Media skill + brief** — `ralph/skills/media/SKILL.md`, `writeRalphBrief` injection.
6. **Credential + cap UI** — registry-generated Settings/Admin "Media generation" cards (ark, suno,
   elevenlabs) + New Build "Media" section (both UIs).
7. **Docs + stub e2e + guarded real smoke** (image/video/music/voiceover).
