# v3.10.192 — Companion Models editor: provider-first + free-text model

Mirrors the desktop v3.3.10 release. Tobe (2026-09-07 10:28
+ 10:57, Discord #cyber-dev): "remove fallbacks and update the
catalog ... add a generic input also ... Do this for both
desktop and mobile."

## What changed (vs v3.10.191)

### 1. Drop Secondary / fallback

The Secondary model picker is gone. The Local-runtimes
Secondary picker is also gone. The Mobile editor now
configures one primary model per companion.

- State: `secondaryModel` removed. The wire field
  `secondaryModel` is no longer written.
- The desktop's `sprite_config_sync` ALLOWED whitelist
  still accepts `secondaryModel` for backward-compat with
  existing sprites.json entries; we just don't write it.

### 2. New provider-first picker

Replaces the v3.10.191 catalog-based pickers. The old
design had 4 cloud providers (Anthropic, OpenAI, Google,
+ each with 2–3 hardcoded model options) + 4 local
providers (Ollama, LM Studio, llama.cpp, vLLM, + each
with 1–11 hardcoded model options). Catalog drift was
the same problem as on the desktop — new models shipped
faster than we updated the lists.

New design:

- **Provider picker** — curated list:
  Anthropic / OpenAI / Google / MiniMax / OpenRouter /
  Mistral / Groq / Custom. Mirrors the desktop forge's
  `FORGE_PROVIDERS` table.
- **API key field** (cloud providers only) — masked
  input. On save, ships to the desktop via the new
  `provider_save` wire message. Desktop writes to its
  `providers.json` registry.
- **Free-text model input** — no catalog restriction.
  Placeholder rotates based on the chosen provider
  (`claude-opus-4-8`, `gpt-5.5`, `MiniMax-M3`, etc.) so
  the user sees a sensible hint, but they can type
  anything.
- **Inline wire preview** — under the model field:
  `→ Saves as: minimax/MiniMax-M3`. Shows the user
  exactly what string will hit the wire.
- **Local runtimes sub-section** — preserved from
  v3.10.191 (Tobe's "separation for local models
  also"). Purple divider. Picks from Ollama / LM Studio /
  llama.cpp / vLLM and swaps the primary provider to the
  chosen local runtime. The free-text model field gets a
  local-flavored placeholder (`llama3`, `local-model`).

### 3. Wire protocol

- New `provider_save` message (sent by mobile's
  `syncClient.sendProviderKey`):
  ```
  { type: 'provider_save', provider: { id, name, baseUrl, apiKey, ... } }
  ```
  Desktop sync-server forwards to the existing
  providers:save logic; persists to
  `~/.openclaw/cyberclaw/providers.json`.
- `sprite_config_sync` patch no longer includes
  `secondaryModel`. Still includes `primaryModel` (the
  composed `provider/model` string).

### 4. State model

Replaced the `primaryModel` + `secondaryModel` strings
with three separate fields:

- `primaryProvider` — the chosen provider id (drives
  wire prefix + key field)
- `primaryModelId` — the model id (free-text)
- `primaryApiKey` — the API key the user pasted

The wire value is computed on every persist + on unmount
via `composeModelRef(provider, modelId)` → `provider/
modelId`. Hydration reads the wire value and splits via
`splitModelRef(value)` → `{ provider, modelId }`.

## Files changed

- `src/screens/CompanionEditScreen.tsx` — replaced
  `MODELS_BY_PROVIDER` (the static catalog) with
  `PROVIDERS_CURATED` + `PROVIDERS_LOCAL` (curated
  provider lists). Dropped `secondaryModel` state + ref.
  Added `splitModelRef` / `composeModelRef` helpers.
  Updated hydration (agents_list + local cache) to use
  the new provider + modelId fields. Rewrote the Models
  mode JSX with the new provider-first flow + free-text
  model input. Bumped `LOOKS_ARENA_HTML_VERSION` is
  untouched (Models is its own section).
- `src/services/SyncClient.ts` — new `sendProviderKey`
  method.
- `package.json` (3.10.191 → 3.10.192),
  `android/app/build.gradle` `versionName` + `versionCode`
  (398 → 399).

## Verification

- TypeScript: `tsc --noEmit` introduces zero new errors.
  Pre-existing errors (`insets`, `companion`, `send`
  private) were already on v3.10.191.
- Manual mental test:
  1. Settings → Companion → Models card. Edit ›
     opens Models editor.
  2. Provider picker default "(empty)". Select
     "🐱 MiniMax". API key field appears.
  3. Paste `sk-minimax-test-...` into the API key
     field. Type `MiniMax-M3` into the model field.
     Inline preview shows "→ Saves as:
     minimax/MiniMax-M3".
  4. Tap ← Back. Mobile ships `{ sprite_config_sync:
     primaryModel: "minimax/MiniMax-M3" }` + a separate
     `{ provider_save: { id: "minimax", apiKey: "...",
     ... } }` to the desktop.
  5. Desktop persists the provider to providers.json +
     merges `minimax/MiniMax-M3` into the companion's
     primaryModel. Re-broadcasts agents_list.
  6. Models card on mobile now shows "🐱 MiniMax /
     MiniMax M3" (pretty-printed).
- Backward-compat: existing companion with
  `primaryModel: "anthropic/claude-opus-4-6"` (saved by
  v3.10.191 or the desktop v3.3.9 forge) opens the editor
  with provider auto-selected as "🅰️ Anthropic" and model
  field showing "claude-opus-4-6". ✓

## UX lessons

- **Provider-first + free-text model id is the right
  shape for an LLM picker.** The user picks the
  *category* (which has stable names) and types the
  *instance* (which has unstable names). The desktop and
  mobile UI matches. The OpenClaw gateway does the
  actual routing.
- **API keys belong in one place.** The mobile's API
  key field is just an entry point — it ships the key
  to the desktop, which writes to its providers.json
  registry. Subsequent companions on the same desktop
  pick it up automatically (the user only enters the
  key once, even if they configure 10 companions
  against the same provider).
- **Visual separation for local runtimes still matters.**
  The purple "💻 LOCAL MODELS" divider from v3.10.191
  is preserved. Self-hosted models have different UX
  (no API key, need an endpoint, run on the user's
  machine). Visually distinct.
