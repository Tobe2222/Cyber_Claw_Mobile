/** AudioPlayer — shared audio playback helper for all desktop-synthesized audio (greeting, AI response, exit reply, attachment viewer audio). */

import { NativeModules, NativeEventEmitter } from 'react-native';

const { WakeWordModule } = NativeModules as any;

let emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter | null {
  if (!WakeWordModule) return null;
  if (!emitter) {
    // NativeEventEmitter takes the module directly (not a wrapped object like on some Android variants).
    try {
      emitter = new NativeEventEmitter(WakeWordModule);
    } catch (_) {
      // Fallback for older RN versions that need a
      // different module signature.
      try {
        emitter = new NativeEventEmitter();
      } catch (_) {
        emitter = null;
      }
    }
  }
  return emitter;
}

/** Play an audio file at the given path and resolve when it finishes (or after a 10s safety timeout). */
export async function playAudioFile(filePath: string, maxMs: number = 10000): Promise<void> {
  if (!WakeWordModule?.startPlayer) {
    throw new Error('WakeWordModule.startPlayer not available');
  }
  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    const finish = (source: string) => {
      if (resolved) return;
      resolved = true;
      try { sub?.remove?.(); } catch (_) {}
      clearTimeout(safetyTimer);
      // If startPlayer hasn't been called yet, we still
      // resolve to avoid hanging the caller.
      resolve();
    };
    const e = getEmitter();
    const sub = e?.addListener?.('audioPlayerFinished', () => finish('play')) ?? null;
    const safetyTimer = setTimeout(() => finish('safety'), maxMs);
    WakeWordModule.startPlayer(filePath, false)
      .then(() => {
        // startPlayer resolved — the audio is now playing.
        // We don't resolve here; we wait for the
        // audioPlayerFinished event OR the safety timer.
      })
      .catch((err: any) => {
        if (resolved) return;
        resolved = true;
        try { sub?.remove?.(); } catch (_) {}
        clearTimeout(safetyTimer);
        reject(err);
      });
  });
}
