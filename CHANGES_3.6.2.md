# v3.6.2

Settings page reorganisation. No code-path behaviour changes; the same
fields are stored under the same AsyncStorage keys. Three moves:

## 1. New "🎙️ Background recording" section (lifted from Listening settings)

The Audio buffer / Lookback (minutes) / Save audio settings controls
previously sat inside the "🎧 Listening settings" section. They're
now in their own top-level section called "🎙️ Background recording"
so it reads as a distinct concept — "this is the recording knob" —
rather than a sub-detail of the master microphone toggle.

The master "🎧 Background listening" toggle and the voice-mode
silence timeout stay in the Listening settings section.

Description copy was rewritten to point at the upcoming
ambient-recording / daily-log feature so the section header explains
what lookbackMinutes is actually configuring (a rolling audio buffer
that the wake-word context uses today, and the ambient daily log
will use in a future release).

## 2. Send word moved to the bottom of the 🐾 Companions section

The send-word input, save button, and "Train" button were moved from
the Listening settings section to the bottom of the 🐾 Companions
section. Label changed to "✉️ Manual send voice message" to make the
purpose explicit — it's the word you say to *commit a voice-mode
turn*, not a microphone setting.

The send word remains GLOBAL across companions (one model, one
phrase, used by all companions). It conceptually belongs with the
other "voice mode send behaviour" controls in the Companions group
rather than with the mic-listening group.

## 3. Voice & Speech trimmed + new "🔑 API keys" section at the bottom

The Voice & Speech section previously combined:
- A working Local (Android TTS) engine and its test buttons
- A Premium API engine selector with provider / key / voice pickers
  that documented themselves as "coming soon"

v3.6.2 trims the Voice & Speech section down to just the working
Local engine + test buttons, with a small premium-API teaser that
points at the new API keys section. Per-companion engine and voice
selection is deferred to v3.7.0 (each companion will get a "Voice"
card in its settings sub-page, mirroring the existing Wake / Exit
sub-page machinery).

The new "🔑 API keys" section at the bottom of Settings contains:
- The ElevenLabs API key input (moved here, same AsyncStorage key
  as before — `voiceApiKey`).
- A master "✨ Enable API speech" toggle. Today the toggle just
  persists the existing `voiceEngine` key; v3.7.0 will consult it
  to gate whether per-companion engine pickers offer "Premium API"
  as an option. The setter that writes this key already exists;
  v3.6.2 makes the toggle visible in the UI as a master gate.
- The provider picker (ElevenLabs / Google Cloud TTS) and a "default
  API voice" picker, both persisted as today. v3.7.0 will use the
  default as the starting point for new companions that pick
  Premium API; individual companions can override.

The API key and master toggle are GLOBAL (one key covers the
device, any companion that uses API voice shares the same key).
Per-companion override of *which* voice / *which* engine is the
v3.7.0 work.

## Why this is a v3.6.2 and not folded into v3.7.0

The settings-page reorganisation is its own clean commit, separate
from the per-companion Voice & Speech work that v3.7.0 will bring.
Splitting them keeps the v3.6.2 diff small and focused on layout
(no new state, no new storage keys, no behaviour change) and lets
the per-companion work land in its own PR with its own review.

## Files changed

- `src/screens/SettingsScreen.tsx` — three section moves + new
  "🎙️ Background recording" and "🔑 API keys" Sections + updated
  file-header comment
