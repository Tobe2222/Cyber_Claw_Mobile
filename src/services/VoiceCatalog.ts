/**
 * VoiceCatalog — local TTS voices only.
 *
 * v3.10.154: stripped cloud TTS scaffolding. ElevenLabs / Google
 * Cloud TTS were decorative — the desktop never honored them,
 * they shipped broken, and they didn't match the local-first
 * direction. All TTS now routes through the device's Android
 * TextToSpeech engine, which is whatever the user has installed
 * (Google TTS, RHVoice, eSpeak NG, Samsung TTS, etc.).
 *
 * What the user picks here is just a label. The actual voice
 * comes from the device's installed TTS engine. We map
 * user-friendly labels to one of a small set of well-known
 * canonical voice names that ship with the most common
 * Android TTS engines:
 *
 *   - 'default'           The system default voice
 *   - 'male' / 'female'   Gender aliases resolved at the
 *                         native layer to the first installed
 *                         voice matching the requested locale
 *                         + gender
 *
 * For RHVoice specifically (the degoogled / F-Droid option
 * Tobe uses on GrapheneOS), the canonical voice names match:
 *   - 'slt'   female, US English
 *   - 'clb'   male, US English (deep)
 *   - 'bdl'   male, US English (lighter)
 *
 * The picker can grow with voice names from real installed
 * engines in a future version — for now this fixed catalog
 * covers the most common Android TTS installations without
 * needing a native bridge just to render a list.
 *
 * The catalog is the source of truth for:
 *   - LOCAL_VOICES: device-language aliases for Android's
 *     on-device TTS engine. The actual voice comes from the
 *     user's installed TTS engine — these are picker labels
 *     resolved by the native TextToSpeech engine.
 */

export type VoiceId = string;

export type LocalVoice = {
  id: VoiceId;
  label: string;
  /** Hint shown next to the label so the user knows which
   *  engine this voice comes from. Used by the Settings UI
   *  to help the user understand why a particular voice is
   *  available / not available. */
  engineHint?: string;
};

/** Local TTS voices. The actual voice comes from the user's
 *  installed TTS engine. These are picker labels mapped to
 *  well-known voice names. */
export const LOCAL_VOICES: LocalVoice[] = [
  { id: 'default', label: '🎙️ System Default', engineHint: 'uses whatever the OS picked' },
  // RHVoice canonical English voices. Tobe uses RHVoice on
  // GrapheneOS — these are the three English voices RHVoice
  // ships by default. If RHVoice isn't installed, the native
  // bridge falls back to the system default.
  { id: 'slt', label: '👩 SLT — Female, US English (RHVoice)', engineHint: 'RHVoice required' },
  { id: 'clb', label: '👨 CLB — Male, US English, deep (RHVoice)', engineHint: 'RHVoice required' },
  { id: 'bdl', label: '👨 BDL — Male, US English, lighter (RHVoice)', engineHint: 'RHVoice required' },
  // Generic gender aliases. Resolved by the native layer to
  // the first voice matching the requested gender in the
  // current locale. Works with any TTS engine (Google TTS,
  // Samsung TTS, etc.) that has at least one male + one
  // female voice installed.
  { id: 'female', label: '👩 Female (auto)', engineHint: 'first female voice in current locale' },
  { id: 'male',   label: '👨 Male (auto)',   engineHint: 'first male voice in current locale' },
];

/** Engine a companion can pick. v3.10.154 simplified to just
 *  local — there is no API/cloud option anymore. 'default'
 *  still exists as a sentinel meaning "use the global master
 *  voice id", preserved so the per-companion override / global
 *  fallback semantics in VoiceSettings.ts still work. */
export type VoiceEngine = 'local' | 'default';

export const DEFAULT_VOICE_ENGINE: VoiceEngine = 'default';

export const DEFAULT_LOCAL_VOICE_ID: VoiceId = 'default';
