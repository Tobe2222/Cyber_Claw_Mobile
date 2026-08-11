/**
 * AudioPlayer — shared audio playback helper for all
 * desktop-synthesized audio (greeting, AI response, exit
 * reply, attachment viewer audio).
 *
 * v3.10.161: lifted out of WakeModeScreen.tsx where it
 * was a closure (playCachedGreeting) so HomeScreen's
 * onAudioResponse handler could call it too. Previously
 * each call site had its own copy of the startPlayer +
 * audioPlayerFinished listener wiring, with subtle
 * differences (the WakeModeScreen version registered the
 * audioPlayerFinished listener, the HomeScreen version
 * didn't) that caused inconsistent behaviour across
 * screens. Centralizing on this helper means a fix in
 * one place applies everywhere.
 *
 * Behaviour:
 * - Calls WakeWordModule.startPlayer with the file path.
 * - Subscribes to `audioPlayerFinished` to detect
 *   natural completion.
 * - Returns a Promise that resolves on either natural
 *   completion OR a 10s safety timeout.
 * - On startPlayer error, the promise rejects with the
 *   underlying error so callers can decide what to do.
 *
 * The 10s safety is generous — desktop-synthesized
 * responses are typically 2-8 seconds. If we hit the
 * safety timeout, something is wrong (audio focus
 * stealing, MediaPlayer hung) and we don't want to
 * block the calling flow indefinitely.
 */

import { NativeModules, NativeEventEmitter } from 'react-native';

const { WakeWordModule } = NativeModules as any;

let emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter | null {
  if (!WakeWordModule) return null;
  if (!emitter) {
    // v3.10.161: NativeEventEmitter takes the module
    // directly (not a wrapped object like on some
    // Android variants). The WakeWordModule has the
    // DeviceEventEmitter constants baked in.
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

/**
 * Play an audio file at the given path and resolve
 * when it finishes (or after a 10s safety timeout).
 * Rejects on startPlayer error.
 */
export async function playAudioFile(filePath: string): Promise<void> {
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
    const safetyTimer = setTimeout(() => finish('safety'), 10000);
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
