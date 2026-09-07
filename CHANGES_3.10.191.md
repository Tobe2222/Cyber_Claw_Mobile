# v3.10.191 — Companion editor: third section (🧠 Models) with local LLM separation

Tobe (2026-09-07 09:28, Discord #cyber-dev):
"Lets introduce the LLM connection for each companion within
the companion editor, create a new section for that with its
own page like looks and behaviour. We do have this on the
desktop already so import that setup. Create a separation for
local models also."

## Background

The mobile companion editor (Personalize screen) was split
into two dedicated pages in v3.10.186:

- 🎨 **Looks** — Sprite, Scale, Name
- 🎭 **Behaviour** — Chattiness, Personality Traits

The desktop's Companion Forge has a third section that the
mobile removed in v3.10.94:

- 🧠 **Models** — Primary / Secondary model dropdowns

Tobe reversed that decision: bring models back, give them
their own dedicated page mirroring Looks + Behaviour, and
visually separate local/self-hosted runtimes from cloud
providers.

## What changed

### 1. New `companion-edit-models` route + `mode='models'`

App.tsx gains a new screen route
`'companion-edit-models'`. CompanionSettingsScreen gets a
new callback prop `onOpenCompanionModels`. Tapping the
Models card's Edit button pushes this route with the same
companion context as the Looks / Behaviour callbacks.

CompanionEditScreen's `mode` prop type widens from
`'looks' | 'behaviour'` to `'looks' | 'behaviour' | 'models'`.
The header label shows "Models" when in models mode
(`Edit {name} — Models`).

### 2. Models editor page (the meat of the release)

Four Sections on the page, mirroring the desktop forge's
structure:

1. **🧠 Primary model** — cloud picker (Anthropic /
   OpenAI / Google) with a "(Default)" sentinel for the
   "use desktop default" state. Default selection maps to
   `primaryModel = ''` on the wire, which the desktop
   falls through to the desktop default model.

2. **🔁 Secondary model** — same picker plus a "(None)"
   sentinel. Empty string → no fallback configured.

3. **💻 LOCAL MODELS** — purple-tinted header divider
   (matches the active-quest visual language). Subtext
   "Self-hosted / private. Runs on your machine —
   private, offline-safe, free." Then two more sections:

   - **🖥️ Local primary** — picker scoped to Ollama /
     LM Studio / llama.cpp / vLLM model tags. Picking
     one here moves the active primary to the local
     model. Picking "(Using cloud primary above)"
     leaves the primary alone.
   - **🖥️ Local secondary** — same picker for
     secondary.

4. **💡 Hint box** — points the user at the desktop's
   "Settings → LLM Endpoints" for runtime setup and the
   desktop's 🧠 LLM status pill for reachability checks.
   The mobile can't probe `localhost` directly on Android
   (would need a permission grant); the desktop
   broadcasts `llm_status` so the user verifies
   reachability there.

### 3. Model catalog constant (`MODELS_BY_PROVIDER`)

Mirrors the desktop forge's `<select>` options verbatim:

- **Anthropic**: Claude Opus 4, Sonnet 4, Haiku 3.5
- **OpenAI**: GPT-4o, GPT-4o Mini
- **Google**: Gemini 2.5 Pro, Gemini 2.5 Flash
- **Ollama**: Llama 3 / 3.1 / 3.2, Mistral, Mistral Nemo,
  Mixtral, CodeLlama, DeepSeek Coder, Qwen 2.5 Coder,
  Gemma 2, Phi-3
- **LM Studio / llama.cpp / vLLM**: single "Local model
  (any)" entry — these runtimes don't have predefined
  model tags the way Ollama does, the user picks the
  model on the runtime side

Same "provider/model" wire format the desktop uses
(`anthropic/claude-opus-4-6`, `ollama/llama3`). No
transformation needed; the desktop's
`sprite_config_sync` whitelist already accepts both
fields.

Keep this list in sync with the desktop forge's HTML
dropdown. Bump the version when adding new models.

### 4. Wire protocol — already there

The desktop's `sprite_config_sync` handler (src/sync-server.js
line 1343) already accepts `primaryModel` and `secondaryModel`
on its ALLOWED whitelist. The mobile just wasn't sending
them since v3.10.94. This release wires them through:

- Hydrate from `agents_list.spriteConfig.{primaryModel,secondaryModel}`
  (same path as scale / chattiness / traits).
- Live-update on subsequent `agents_list` broadcasts while
  the editor is open (matches the existing patterns).
- Local cache (`cyberclaw-companion-edit-{id}`) gains
  `primaryModel` / `secondaryModel` keys for the offline
  fallback.
- On unmount (back tap / OS back gesture), the patch
  includes both fields. Empty string → sent as `undefined`
  to the wire (clear the field on the desktop).
- Per-change AsyncStorage persist keeps the local cache
  in sync with the desktop so the Models card on
  CompanionSettingsScreen reflects edits immediately.

### 5. Models card on CompanionSettingsScreen

A new card in the same shape as the Looks + Behaviour
cards:

- 🧠 **Models** title + Edit › button
- Row: **Primary** — formatted provider + model name.
  Green dot prefix if the primary is a local model
  (visual cue "this companion is running against a
  local LLM"). Falls back to "Default" when no primary
  is set.
- Row: **Secondary** — same display, falls back to
  "None" when empty.
- Footer hint: "Secondary is the fallback used when the
  primary is down."

Pretty-printing mirrors the desktop's `formatModelName()`
in src/js/app.js so both surfaces show the same display
names for the same model id. Provider detection
recognizes the same local-provider list as the editor:
`ollama`, `lmstudio`, `llamacpp`, `vllm`.

## Files changed

- `App.tsx` — new `'companion-edit-models'` route,
  `onOpenCompanionModels` callback wired to
  CompanionSettingsScreen.
- `src/screens/CompanionSettingsScreen.tsx` — new
  `renderModelsCard` helper, new `onOpenCompanionModels`
  prop, three new styles (`modelLocalDot`, `modelDefault`,
  `modelFooterHint`).
- `src/screens/CompanionEditScreen.tsx` — `mode` prop
  accepts `'models'`, new `MODELS_BY_PROVIDER` /
  `MODEL_DEFAULT_NONE` / `LOCAL_PROVIDERS` / `isLocalModel`
  constants, `primaryModel` / `secondaryModel` state +
  refs + hydrate + persist + unmount-save, full Models
  mode JSX block (header label, four sections, hint box,
  three new styles).
- `package.json` (3.10.190 → 3.10.191),
  `android/app/build.gradle` `versionName` (3.10.190 →
  3.10.191) and `versionCode` (397 → 398).

## Verification

- TypeScript: `tsc --noEmit` introduces zero new errors.
  Two pre-existing errors (`insets` possibly undefined,
  `companion` used before declaration) are unrelated and
  were already on v3.10.190.
- Manual mental test:
  1. Settings → Companion → Models card shows
     `Primary: Default` / `Secondary: None` for a new
     companion (no spriteConfig yet).
  2. Tap Edit › → opens 🧠 MODELS editor with the
     cloud pickers (Anthropic / OpenAI / Google)
     followed by the purple LOCAL MODELS divider and
     Ollama / LM Studio / llama.cpp / vLLM pickers.
  3. Pick `Anthropic / Claude Opus 4` as primary →
     state updates → on back, Models card shows
     `Primary: Anthropic / Claude Opus 4`.
  4. Pick `Ollama / Llama 3` as local primary →
     state updates → green dot appears next to
     "Llama 3" on the Models card.
  5. Tap Save (implicit, on unmount) → desktop
     receives `sprite_config_sync` with
     `{primaryModel: 'ollama/llama3', ...}` →
     desktop writes to sprites.json → next agents_list
     broadcast updates both the editor (if still
     open) and the Models card.
- The desktop's LLM status pill will show "🔴 Ollama
  down" if Ollama isn't running on the desktop. The
  mobile can't probe localhost directly (Android
  permission restriction); the desktop broadcasts the
  status. Documented in the hint box.

## UX lessons

- **Dedicated pages for editor sections keep the cognitive
  load flat.** Looks + Behaviour split in v3.10.186 made
  each page feel focused. Adding Models as a third page
  is the same pattern — each section is a focused
  experience, not a scrolly dump.
- **Visual separation matters for cross-cutting categories.**
  Local models are conceptually different from cloud
  models (privacy, cost, offline, setup requirements).
  Putting them in the same picker without a divider would
  bury that distinction. The purple "💻 LOCAL MODELS"
  header divider makes the category break obvious at a
  glance.
- **The mobile can't do everything the desktop can.**
  Probing localhost on Android needs a permission grant
  the user has to explicitly opt into. Rather than add
  a confusing permission flow, we point the user at the
  desktop's LLM pill (which already probes the endpoint)
  and document that in the hint box.
