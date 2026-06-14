# Changelog — v3.1.13 (session 2026-06-14)

Branch: `main`. Tag: `v3.1.13`. Build: `versionCode 63`.

---

## v3.1.13 — Settings cleanup + voice settings restored

### 1. Voice settings restored

The mobile's `ArenaSettingsScreen` was deleted in v3.1.12 (per
Tobe's request — desktop owns the bg/companion picker). But the
screen also contained the **voice & speech settings** (local TTS
toggle, voice selection, premium API provider/key/voice). Those
got lost in the move.

This release brings them back as a proper **"🔊 Voice & Speech"**
section in the main settings screen. The premium API provider,
API key, and premium voice selection are auto-saved to the same
AsyncStorage keys the deleted screen used, so existing user
preferences (if any) carry over.

- Local voice toggle (default: ON, uses Android's built-in TTS)
- Voice selection: System Default / Male / Female
- **Test local voice on phone** button (calls
  `WakeWordModule.speakText` directly)
- **Test voice on desktop** button (sends a speak action to the
  desktop's WebView, which speaks via Web Speech API — this was
  the only "test" the deleted screen had)
- Premium voice API: provider (ElevenLabs / Google Cloud TTS),
  API key, premium voice. Clearly marked as **"coming soon"** —
  the desktop doesn't consume these yet, so the section is
  read-only-ish until the bridge is wired. The key is persisted
  so it'll be picked up when the bridge lands.

### 2. Five clean categories

The previous settings screen was 1114 lines with 8+ flat sections
that mixed concepts. Reorganized into 5 well-defined categories
with consistent structure (title, description, controls):

| Section | What it covers |
|---------|----------------|
| 🔗 **Connection** | Desktop IP, connect button, status, log, pairing |
| 🔒 **Permissions** | Runtime perms (mic, notif) + wake perms (draw over, full screen intent) |
| 🎤 **Wake Word** | Background listening, threshold, training buttons, wake greeting, audio buffer settings |
| 🔊 **Voice & Speech** | Local TTS, premium API |
| 🤖 **Agent Reach** | File system, app control, location, camera, notifications |

All wake-related stuff (background listening, threshold, training,
greeting, audio buffer) is now in one place. All permission stuff
(runtime + wake) is in one place. Connection is its own thing.
Voice is its own thing. Agent Reach is its own thing.

### 3. Dead state removed

The previous screen had 21 `useState` declarations, several of
which were never displayed or were leftovers from removed
features. Removed:

- `ttsEnabled` — read from AsyncStorage on mount, never used in
  the UI. The TTS state is now owned by the new voice settings
  (the local-voice toggle replaces it).
- `wakePhrase` — duplicate of `selectedWakePhrase`. Removed.
- `wakeMode` / `ppnPath` — read on mount, persisted, but had no
  UI (the Vosk/Porcupine selector was removed earlier). State
  loading is removed. App still reads them directly from
  AsyncStorage (unchanged).
- `wakeTrained` — set, never displayed. Trainer components
  handle their own state.
- `showTrainer` / `showTrainingManager` — the old V1 trainer and
  TrainingManager are no longer reachable from this screen.
  V2 trainer is the only path.
- `setShowTrainerV2` — the V2 trainer's sub-flow was triggered
  from the WakePhraseMenu → TrainingDetail flow, not directly
  from settings. Removed. (Re-added when I needed it for
  `WakePhraseMenu`'s "add training" path.)

### 4. UX improvements

- **Wake Greeting input is no longer cluttered.** The previous
  version had a redundant explicit Save button + onBlur +
  onSubmitEditing + 600ms debounce — all doing the same thing.
  Now: one TextInput with debounced auto-save (no explicit Save
  button needed), and a tiny "Saved at HH:MM:SS" confirmation
  appears once it persists. Cleaner and works the way users
  expect.
- **Save Settings button gone.** Most settings auto-save (as
  they always have). Only the audio buffer settings (lookback,
  conversation timeout, retention) need an explicit save —
  that's now a small "💾 Save audio settings" button INSIDE the
  Wake Word section, right where those settings live. No more
  mystery save button at the bottom of the page.
- **Wake permissions moved into the Permissions section.** They
  used to be buried inside the "Always Listening" section.
  Now they sit right under the runtime permissions (mic, notif)
  with a "Wake word permissions" sub-heading, so the user sees
  them together with the other permission grants.
- **About footer added.** Small section at the bottom with the
  app version (read from `package.json`) and a GitHub link.
- **Reusable section components.** Introduced
  `Section` / `SubTitle` / `Label` / `Hint` / `Toggle` /
  `OptionBtn` inline components. The new file is 831 lines (down
  from 1114) despite adding a whole new section.

### 5. Code quality

- New file is fully typed (no new TS errors).
- All AsyncStorage keys match what the desktop + remaining
  code (HomeScreen, App.tsx, etc.) reads. No key renames, so
  existing user data is preserved.
- Existing sub-screen flow (WakePhraseMenu → TrainingDetail
  → WakeWordTrainerV2) is unchanged. Back button navigates the
  sub-screens correctly.
- `tsc --noEmit` clean (one pre-existing `)}` JSX error in
  HomeScreen.tsx line 1699, unrelated to this work).

### Files changed

```
src/screens/SettingsScreen.tsx    1114 → 831 lines (-283)
                                  +🔊 Voice & Speech section
                                  + 5-section organization
                                  - 7 dead useState declarations
                                  + reusable Section/Toggle/OptionBtn
                                  + About footer
CHANGES_3.1.13.md                 NEW
```

### How to test in the app

1. Build the APK: `npm run android` (or download from the
   `v3.1.13` GitHub release).
2. Open Settings from the home screen cog.
3. **🔗 Connection** — should work the same as before. Enter IP,
   tap Connect, watch the log.
4. **🔒 Permissions** — mic, notifications, and the two wake
   permissions (draw over, full screen intent) are all here.
5. **🎤 Wake Word** — background listening toggle, threshold
   slider, wake training button, wake greeting input, audio
   buffer settings (lookback / conversation timeout / retention
   with a Save button right under them).
6. **🔊 Voice & Speech** — NEW. Local TTS toggle, voice
   selection (default/male/female), test local voice button,
   test desktop voice button, premium API section (marked
   "coming soon").
7. **🤖 Agent Reach** — file read/write, launch intent,
   location, camera, notifications (greyed out as not yet
   supported).
8. **About footer** — version + GitHub link at the very bottom.
