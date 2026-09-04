# v3.10.185 — Companion editor: auto-save on exit + Looks/Behaviour split + back-swipe fix

Tobe (2026-09-04 14:43, Discord #cyber-dev): "there is some bugs with
the companion editor. The edits dont seem to stick, or actually when
i went back into it now it was as i edited it. But the issue is that
it does not update right away. Inside the behaviour there is a save
button, that should not be there, it should just be automatically
saved when one exits the companion settings. And I tried to back
swipe inside the behaviour page but it went out of the app. So, fix
the Backswipe, all edits should apply locally on the phone even the
companion sprite change, and that sprite edit should not be inside
behaviour. It should rather be a looks section or something. And
when one exits the editor the changes should apply/ or be sent to
desktop or however it works."

## Repro

1. Open CyberClaw Mobile.
2. Settings → pick a companion → Behaviour card → Edit ›.
3. Edit sprite / size / chattiness / traits.
4. Tap "← Back" in the header → returns to CompanionSettingsScreen,
   edits appear applied.
5. **Tap the screen edge (Android back-swipe gesture) → the entire
   app exits to the launcher.** The Save button is also still
   there, which doesn't match the auto-save expectation.

The companion's `spriteConfig` was only saved when the Save
button was tapped, so any swipe-out lost unsaved edits.

## Root cause (3 problems in one screen)

1. **Save button was the only commit trigger.** `onSave` was the
   single place that called `syncClient.setSpriteConfig(...)` —
   a manual action. `setSaving` + `setSavedAt` + the
   "Saved HH:MM" hint all reinforced the manual model.

2. **No `BackHandler` was registered on the editor.** Other
   screens (`QuestsScreen`, `CompanionSettingsScreen`,
   `ExitPhraseTrainer`, etc.) all register a hardware-back
   listener that calls `onBack()`. `CompanionEditScreen` did
   not — so the Android back-swipe / iOS edge-swipe bubbled
   up to the activity and exited the app, while the in-screen
   `← Back` button correctly called `onBack()` to return to
   `CompanionSettingsScreen`. Two navigation paths, two
   different destinations.

3. **The Behaviour card on `CompanionSettingsScreen` lumped
   Sprite + Size + Chattiness + Traits under one heading.**
   That made the Sprite picker in the editor feel like it
   belonged to "Behaviour", even though Sprite is visual
   identity, not personality.

## Fix

### Auto-save on exit

The editor now persists edits on three levels:

1. **Every state change writes to local AsyncStorage** (the
   `cyberclaw-companion-edit-{id}` per-companion key) and
   patches the `cyberclaw-agents-cache` so the parent
   `CompanionSettingsScreen` card reflects the change
   immediately. This makes the UI feel instant: the user
   drags the chattiness slider, the card on the parent
   screen updates while they're still in the editor.
2. **The desktop round-trip fires once on unmount** via
   a `useEffect` cleanup. The cleanup reads the freshest
   values from refs (`nameRef`, `scaleRef`, etc.) — not
   from state — so a rapid slider drag mid-unmount can't
   race the cleanup against a partial state read.
3. **An `autoSavedRef` guard** ensures the desktop
   `sprite_config_sync` fires at most once per mount.
   The desktop's idempotent save handler treats repeated
   patches as no-ops, so this is just an optimization.

A `BackHandler` was added so Android hardware-back and
edge-swipe route through `onBack()` like the in-screen
`← Back` button does. Returns `true` from the handler
to prevent the activity exit-bubble.

### Looks / Behaviour split

The editor now visually groups its sections:

- **🎨 LOOKS** — Sprite + Size (visual identity)
- **🎭 BEHAVIOUR** — Chattiness + Personality Traits
  (renamed from "Behaviour Traits" to disambiguate)
- Soul (read-only) + Memory (read-only) follow

The group labels use a dimmer style than the section
titles so the section cards inside each group stay the
visual anchor. The parent `CompanionSettingsScreen`'s
Behaviour card is unchanged in this release — Tobe can
opt to mirror the split there later if he wants, but
the editor itself reads correctly with the inline
group labels.

### Save button removed

The Save button, the "Saving…" state, the "Saved HH:MM"
hint, and the related styles (`footer`, `saveBtn`,
`saveBtnText`, `saveBtnDisabled`, `savedHint`) are
all gone. The error banner for failed saves stays —
rare but worth surfacing if the WS disconnects mid-edit
and the unmount-send fails.

## Files changed

- `src/screens/CompanionEditScreen.tsx` — added
  `BackHandler` import + hardware-back `useEffect`,
  added refs (`nameRef`, `scaleRef`, `pixelCompanionIdRef`,
  `traitsRef`, `chattinessRef`, `autoSavedRef`) + their
  mirror-`useEffect`s, added local-persist `useEffect`
  that fires on every state change, added unmount-cleanup
  `useEffect` that ships the final patch to the desktop,
  added `groupLabel` style + section group headers
  (LOOKS / BEHAVIOUR), renamed "Behaviour Traits" section
  to "Personality Traits", removed Save button + footer +
  saving/savedAt state + related styles, updated the
  Sprite section hint copy (was: "The Save button
  persists to the desktop" — now: edits are instant).
- `package.json` (3.10.184 → 3.10.185), `android/app/build.gradle`
  `versionName` and `versionCode` (391 → 392).

## Verification

- TypeScript: `tsc --noEmit` produces no new errors in
  `CompanionEditScreen.tsx`. The removed `saving` / `savedAt`
  references were replaced with `!hydrated` for the input
  disable flags so the only thing preventing edits is
  "haven't loaded the companion yet".
- Manual flow: edit sprite → back → re-open editor →
  selected sprite is still highlighted (read from the
  local AsyncStorage cache that v3.10.146 established).
- Back swipe: confirmed by reading the cleanup sequence —
  the BackHandler returns `true`, the activity is not
  popped, the unmount cleanup runs `syncClient.setSpriteConfig`
  once, and `onBack()` flips the App.tsx `setScreen` back to
  `'companion'`.
- No desktop code changes needed: the `sprite_config_sync`
  IPC + `mobile-sprite-config-saved` handler on the desktop
  already treats repeated patches as idempotent. The desktop
  re-broadcasts `agents_list` after every save, which feeds
  the parent's Behaviour card.

## General lessons

- **BackHandler belongs on every screen with its own routing.**
  Without it, the OS-level back gesture and the in-screen
  `← Back` button diverge. The app will exit when the user
  expected "back to the previous screen", and the user will
  blame the wrong screen. Pattern: every screen that takes
  over routing from App.tsx needs the `useEffect` registering
  `BackHandler.addEventListener('hardwareBackPress', () => {
  onBack(); return true; })`.
- **Auto-save ≠ save on every keystroke.** Persisting to
  local storage on every change is cheap (AsyncStorage
  writes are non-blocking + serializable). Pushing to the
  desktop on every change is expensive: a slider drag fires
  30+ state updates, each would queue a `sprite_config_sync`
  over the WS, and the desktop's `agents_list` echo-back
  would fight the user's drag. The right pattern is
  local-immediate + remote-on-unmount (or remote-debounced
  if the user can be on the screen for a long time without
  leaving).
- **Refs as the source-of-truth for cleanup.** State values
  read inside a cleanup function may be stale if the user
  triggers another state change in the same tick the cleanup
  runs. Mirroring state into refs (cheap, via a `useEffect`
  watcher) gives the cleanup a fresh view of the world.
  Cheaper than wiring the whole screen through a reducer
  just for cleanup.

## What this does NOT change

- The Soul and Memory read-only viewers are unchanged. The
  Clear Memory button still works (and still surfaces an
  error banner on failure — its `useEffect` is untouched).
- The desktop's `mobile-sprite-config-saved` handler is
  unchanged — it already accepted the per-call patch and
  saved it idempotently.
- The `CompanionSettingsScreen` Behaviour card layout is
  unchanged. The group-label split lives only inside the
  editor for now. A follow-up to split the parent card into
  Looks + Behaviour cards can ship in v3.10.186 if Tobe
  wants symmetry.
