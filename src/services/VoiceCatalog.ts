/**
 * VoiceCatalog — TTS voices, mirror of the desktop.
 *
 * v3.10.154: stripped cloud TTS scaffolding. ElevenLabs / Google
 * Cloud TTS were decorative — the desktop never honored them,
 * they shipped broken, and they didn't match the local-first
 * direction.
 *
 * v3.10.163: the dominant path is now desktop-piper synthesis.
 * The mobile voice picker used to be a static list of Android
 * TTS fallback ids (slt / clb / bdl / female / male) that the
 * mobile wrote to AsyncStorage and the desktop never saw. The
 * actual piper voice came from the desktop's own
 * cyberclaw-settings.ttsVoice in localStorage.
 *
 * v3.10.165: the mobile picker is now an extension of the
 * desktop's piper list. The mobile requests the list from the
 * desktop at app start (request_tts_settings) and renders
 * whatever the desktop reports. The 8 entries below are a
 * client-side FALLBACK used only if the desktop doesn't
 * support v3.10.165+ yet (e.g. on an older desktop or before
 * the desktop has been restarted with the new IPC). When the
 * desktop's response arrives, the picker re-renders from that.
 *
 * Voices are kept in sync with src/index.html on the desktop
 * (the settings-tts-voice <select>). If the desktop grows a
 * voice, the mobile picks it up via the IPC; this fallback
 * list only matters on cold-start before the IPC response.
 *
 * The actual voice comes from the desktop's piper pipeline
 * (src/local-ai.js PIPER_VOICES). The mobile picker is just
 * UI that sends a preference to the desktop via
 * syncClient.setTtsVoice(voice).
 */

export type VoiceId = string;

export type LocalVoice = {
  id: VoiceId;
  label: string;
  /** One-line description shown under the label in the
   *  picker. Kept short so the settings list doesn't bloat. */
  desc: string;
  /** "Female" | "Male" — used by the picker to group voices
   *  in optgroup-like UI. Mirrors the <optgroup> structure
   *  in the desktop's index.html. */
  group?: string;
};

/** Client-side fallback only. The desktop's list (returned
 *  by request_tts_settings) is the source of truth at
 *  runtime. This list is shown for ~1s on cold start, or
 *  when the desktop doesn't support the v3.10.165 IPC yet. */
export const LOCAL_VOICES: LocalVoice[] = [
  // Female
  { id: 'amy',      label: 'Amy',       desc: 'US, warm & conversational',     group: 'Female' },
  { id: 'kathleen', label: 'Kathleen',  desc: 'US, clear & professional',      group: 'Female' },
  { id: 'jenny',    label: 'Jenny',     desc: 'British',                       group: 'Female' },
  { id: 'kristin',  label: 'Kristin',   desc: 'US, low & breathy',             group: 'Female' },
  // Male
  { id: 'lessac',   label: 'Lessac',    desc: 'US, baseline',                  group: 'Male' },
  { id: 'joe',      label: 'Joe',       desc: 'US, slightly deeper',           group: 'Male' },
  { id: 'ryan',     label: 'Ryan',      desc: 'US, alternative male',          group: 'Male' },
  { id: 'sam',      label: 'Sam',       desc: 'US, smooth & warm',             group: 'Male' },
];

/** Engine a companion can pick. v3.10.154 simplified to just
 *  local — there is no API/cloud option anymore. 'default'
 *  still exists as a sentinel meaning "use the global master
 *  voice id", preserved so the per-companion override / global
 *  fallback semantics in VoiceSettings.ts still work. */
export type VoiceEngine = 'local' | 'default';

export const DEFAULT_VOICE_ENGINE: VoiceEngine = 'default';

export const DEFAULT_LOCAL_VOICE_ID: VoiceId = 'lessac';
