/** VoiceCatalog — TTS voices, mirror of the desktop. */

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

/** Client-side fallback only. */
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

/** Engine a companion can pick. */
export type VoiceEngine = 'local' | 'default';

export const DEFAULT_VOICE_ENGINE: VoiceEngine = 'default';

export const DEFAULT_LOCAL_VOICE_ID: VoiceId = 'lessac';
