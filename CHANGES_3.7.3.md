# v3.7.3

Push per-companion silence to the desktop. The phone has been
the only place per-companion silence lived (AsyncStorage
key `cyberclaw-voice-silence-ms-<companionId>` from v3.7.2).
A phone reinstall loses it. v3.7.3 closes that gap by pushing
the value to the desktop on every Save; the desktop persists
it and replays it to other connected phones.

## What changed

### `src/services/SyncClient.ts`

Two additions:

1. **New `setCompanionSilence(agentId, silenceMs)` method**
   that sends `set_companion_silence` over the wire.
   Best-effort: only called when connected; offline saves
   still work locally and will sync on next connect.

2. **New `case 'companion_settings_sync':` handler** that
   re-emits the message as a local event. The voice sub-page
   subscribes to this to pick up the desktop's value on
   reconnect (or after a phone reinstall).

### `src/screens/CompanionSettingsScreen.tsx`

1. **`saveSilence` callback now pushes to the desktop.**
   After the local `saveSilenceMs(companionId, vcSilenceMs)`
   write, it also calls `syncClient.setCompanionSilence(companionId, vcSilenceMs)`
   if connected. The local write is still the source of
   truth for the phone's runtime; the push is for
   cross-device consistency.

2. **New `useEffect` listening for `companion_settings_sync`.**
   When the desktop sends a per-companion settings update
   and we don't have a local value for that companion
   (`AsyncStorage.getItem` returns null), adopt the
   desktop's value. This is the "phone reinstall recovery"
   path: a fresh install with empty AsyncStorage gets the
   desktop's stored value on the next auth.

   We don't overwrite a local value: local is the phone's
   source of truth, and overwriting it would lose any
   unsaved edits the user is making on the phone.

## What did NOT change

- The local AsyncStorage key is still the source of truth
  for the phone's runtime. `loadVoiceSettings(companionId)`
  still reads the per-companion key first, falls back to
  the v3.7.1 global.
- The silence UI (radio rows + Save button) is unchanged.
  The Save button just does more now (local + push).
- The v3.7.0 voice engine / voice picker are unchanged.
  Per Tobe, voice settings can stay phone-only; the desktop
  has its own piper TTS pipeline. This PR syncs *silence*
  only.

## Files changed

- `src/services/SyncClient.ts` — new `setCompanionSilence`
  method, new `case 'companion_settings_sync':` handler.
- `src/screens/CompanionSettingsScreen.tsx` — `saveSilence`
  pushes to desktop; new `useEffect` listens for
  `companion_settings_sync` to recover from a phone
  reinstall.

## Companion desktop change (CyberClaw v3.1.50)

The desktop's `src/sync-server.js` got a new
`set_companion_silence` case that validates, writes to
`~/.openclaw/cyberclaw/companion-settings.json`, and
broadcasts `companion_settings_sync` to all clients. The
desktop's `voice:start-recording` IPC handler now applies
the per-companion value as a max-recording floor when
`agentId` is provided.

See `CyberClaw/CHANGES_3.1.50.md` for the desktop side.
