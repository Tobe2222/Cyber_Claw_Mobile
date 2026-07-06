/**
 * VoiceCatalog — shared voice + provider catalog.
 *
 * v3.7.0: extracted from SettingsScreen.tsx so the per-companion
 * voice picker in CompanionSettingsScreen.tsx can render the
 * same options. Both the global Settings screen and each
 * companion's voice sub-page consume this list.
 *
 * The catalog is the source of truth for:
 *   - LOCAL_VOICES: device-language aliases for Android's
 *     on-device TTS engine. The actual voice comes from the
 *     user's installed TTS engine — these are picker labels.
 *   - PREMIUM_PROVIDERS: cloud TTS providers (ElevenLabs,
 *     Google Cloud TTS) and their available voices.
 *
 * v3.6.2 note: the API keys (ElevenLabs) live in the global
 * 🔑 API keys section, not per-companion. The premium picker
 * is gated on the global "✨ Enable API speech" toggle. The
 * per-companion setting only chooses which engine + voice
 * each companion uses, not which key.
 */

export type VoiceId = string;

export type LocalVoice = {
  id: VoiceId;
  label: string;
};

export type PremiumVoice = {
  id: VoiceId;
  label: string;
};

export type PremiumProvider = {
  id: VoiceId;
  label: string;
  voices: PremiumVoice[];
};

/** Android on-device TTS voice aliases. The actual voice comes
 *  from the user's installed TTS engine. */
export const LOCAL_VOICES: LocalVoice[] = [
  { id: 'default', label: '🎙️ System Default' },
  { id: 'male',    label: '👨 Male' },
  { id: 'female',  label: '👩 Female' },
];

/** Cloud TTS providers + their voices. The desktop bridge to
 *  consume these on the synthesis side ships in v3.7.0. */
export const PREMIUM_PROVIDERS: PremiumProvider[] = [
  { id: 'elevenlabs', label: 'ElevenLabs', voices: [
    { id: 'nova',    label: '✨ Nova (Female — bright)' },
    { id: 'alloy',   label: '🎙️ Alloy (Male — friendly)' },
    { id: 'echo',    label: '🌊 Echo (Male — deep)' },
    { id: 'fable',   label: '📖 Fable (Female — storyteller)' },
    { id: 'onyx',    label: '⚫ Onyx (Male — smooth)' },
    { id: 'shimmer', label: '✨ Shimmer (Female — warm)' },
  ]},
  { id: 'google', label: 'Google Cloud TTS', voices: [
    { id: 'en-US-Neural2-A', label: '🗣️ A (Female)' },
    { id: 'en-US-Neural2-C', label: '🗣️ C (Female)' },
    { id: 'en-US-Neural2-E', label: '🗣️ E (Male)' },
  ]},
];

/** Engine a companion can pick. 'default' means "use whatever
 *  the global master voiceEngine is". */
export type VoiceEngine = 'local' | 'api' | 'default';

export const DEFAULT_VOICE_ENGINE: VoiceEngine = 'default';

export const DEFAULT_LOCAL_VOICE_ID: VoiceId = 'default';
export const DEFAULT_API_PROVIDER_ID: VoiceId = 'elevenlabs';
export const DEFAULT_API_VOICE_ID: VoiceId = 'nova';
