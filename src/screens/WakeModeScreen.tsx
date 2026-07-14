/**
 * WakeModeScreen — Fullscreen Wake Mode UI for mobile
 *
 * v3.1.12: This screen replaces the previous approach of flipping a
 * `fullscreen` boolean in HomeScreen when the wake word fires. The
 * boolean approach was racy — the wake event would set fullscreen,
 * then a state wipe would re-render HomeScreen without the fullscreen
 * flag, landing the user on the home screen instead of Wake Mode.
 *
 * This dedicated screen ALWAYS renders the Wake Mode fullscreen UI.
 * It's a modal route — App.tsx switches here when the wake event
 * fires. When the user exits (X button or back), it returns home.
 *
 * Visual: black background, fullscreen WebView in Wake Mode style,
 * green voice log overlay, orange status overlay, X close button.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, BackHandler, StatusBar,
  NativeModules, NativeEventEmitter, AppState,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

import syncClient from '../services/SyncClient';
import { getSimpleAudioRecorder } from '../services/SimpleAudioRecorder';
import { getVAD, resetVAD } from '../services/SileroVAD';
import { loadVoiceSettings, DEFAULT_SILENCE_MS } from '../services/VoiceSettings';
import { matchExitPhrase } from '../services/ExitPhraseMatcher';
import { extractAudioFeatures, matchAgainstTraining, matchAgainstAllCompanions, AudioFeatures } from '../services/AudioSampleMatcher';
import { base64ToInt16Array } from '../services/AudioUtils';

import { addLogEntry } from './HomeScreen';
// v3.1.50: APP_VERSION is used as a WebView cache-buster (forces
// fresh asset load on every APK upgrade) and to detect "wake mode"
// vs "home mode" in the arena via ?mode=wake.
import { version as APP_VERSION } from '../../package.json';
// v3.1.79: false-open detector + idle timeout. Auto-tightens the
// match threshold if Wake / Voice Mode keeps getting opened by
// accident (TV, another person, false positive), and auto-closes
// the mode if no input has happened for 60s.
import { noteWakeModeOpen, noteWakeModeExit } from '../services/WakeTrainingModel';
import { getCachedGreetingPath, ensureGreetingCached } from '../services/GreetingAudioCache';

const { AppControl, WakeWordModule } = NativeModules;

let _wakeWordEmitter: NativeEventEmitter | null = null;
const getWakeWordEmitter = () => {
  if (!_wakeWordEmitter && WakeWordModule) {
    _wakeWordEmitter = new NativeEventEmitter(WakeWordModule);
  }
  return _wakeWordEmitter;
};
const wakeWordEmitter = { addListener: (event: string, cb: (...args: any[]) => void) => getWakeWordEmitter()?.addListener(event, cb) ?? null };

const SAMPLE_MATCH_THRESHOLD_FG = 0.5;
const SAMPLE_MATCH_THRESHOLD_BG = 0.6;
const getWakeSamplesKey = (phrase: string) =>
  `cyberclaw-wake-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

function startSampleMatchListener(
  companionsTraining: Array<{ companionId: string; features: AudioFeatures[] }>,
  onDetected: (matchedCompanionId: string) => void,
  onLog?: (msg: string) => void,
  threshold?: number,
): () => void {
  // v3.1.95: replaced DTW-based sample matcher with openWakeWord
  // TFLite inference. Native-side ML on the audio stream emits
  // 'owwWakeDetected' when a wake word fires. See the matching
  // comment in HomeScreen.tsx for the full rationale.
  let stopped = false;
  const sub = wakeWordEmitter?.addListener('owwWakeDetected', (e: { score: number; wakeword: string }) => {
    if (stopped) return;
    onLog?.(`✅ Wake word detected: ${e.wakeword} (${(e.score * 100).toFixed(0)}%)`);
    const activeId = companionsTraining[0]?.companionId;
    if (activeId) onDetected(activeId);
  });
  // v3.2.16: init OWW with the active companion's saved wake
  // phrase (if any), falling back to 'hey_jarvis'. Previously
  // this hardcoded 'hey_jarvis' which meant a custom-trained
  // wake word model was never active in the OWW detector — the
  // trainer hot-swapped the model file in, but the detector
  // was looking for 'hey_jarvis' activations. 'hey clawsuu'
  // wouldn't match 'hey_jarvis' even though the trained model
  // file was loaded.
  const activeIdForInit = companionsTraining[0]?.companionId;
  let wakePhrase = 'hey_jarvis';
  if (activeIdForInit) {
    try {
      const models = WakeWordModule?.getSavedWakeModels?.();
      const entry = models?.[activeIdForInit];
      if (entry?.phrase) wakePhrase = entry.phrase;
    } catch (_) {}
  }
  WakeWordModule?.initOww?.(wakePhrase, threshold ?? 0.5)
    .catch((e: any) => onLog?.(`initOww failed for "${wakePhrase}": ${e?.message}`))
    .then(() => WakeWordModule?.startOwwListening?.())
    .catch((e: any) => onLog?.(`startOwwListening failed: ${e?.message}`));
  return () => {
    stopped = true;
    sub?.remove?.();
    WakeWordModule?.stopOwwListening?.().catch(() => {});
  };
}

interface WakeModeScreenProps {
  companionId: string;
  agents: Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null }>;
  onExit: () => void;
  // v3.1.65: voiceMode disables the wake word listener AND
  // starts the VAD + recorder automatically (the voice mode
  // process). Tobe: "wake mode looks good, just copy the
  // style of wake mode. It should look exactly the same.
  // Why are you screwing so much about it?" — the simplest
  // path is to use this SAME component for both modes, with
  // a prop that swaps the function (wake listener vs VAD+
  // recorder) while keeping the visual identical.
  voiceMode?: boolean;
  // v3.1.67: called when the wake word matches. Receives
  // the matched companionId so the parent (App.tsx) can
  // update its active companion and the wake mode can show
  // the right one.
  onWakeMatch?: (matchedCompanionId: string) => void;
}

export default function WakeModeScreen({ companionId, agents, onExit, voiceMode = false, onWakeMatch }: WakeModeScreenProps) {
  const webViewRef = useRef<WebView>(null);
  const recorderActiveRef = useRef<boolean>(false);
  // v3.9.6 — ref for the per-turn silence listener unsub.
  // startRecordingTurn registers `recorder.once('silence', ...)`
  // and stores the unsub here; stopAndSendRecording calls it at
  // the top to clean up. Without this, listeners accumulate
  // across turns (e.g. when silence never fires because the
  // turn ended via send-word or gibberish-gate skip) and ALL of
  // them fire on the next silence event — each one runs its
  // own 3s countdown and calls stopAndSendRecording, so the
  // first silence event after a few turns cuts every recording
  // off within 1s instead of silenceMs + 3s. Tobe reported
  // this in v3.9.5: "longer conversation → faster silence".
  const silenceUnsubRef = useRef<(() => void) | null>(null);
  // v3.9.6 — ref for the JS-side 3s countdown setInterval id.
  // Same accumulation problem: the silence handler starts a
  // countdown; if the turn ends early (via send-word, etc.) the
  // countdown is orphaned and keeps ticking in the background,
  // eventually firing stopAndSendRecording on the next turn.
  const silenceCountdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // v3.10.9: tracks whether the silence listener has
  // fired its initial countdown for the current silence
  // period. The native side re-emits 'recorderSilence'
  // every 80ms while silence persists (until speech
  // resets the internal counter). We use this flag to
  // make sure we only START a countdown once per silence
  // period, not every 80ms. Reset to false when speech
  // resumes so the next silence period can fire again.
  const silenceFiredRef = useRef<boolean>(false);
  const sampleListenerCleanupRef = useRef<(() => void) | null>(null);
  const wakeWordBusyRef = useRef(false);
  const appStateRef = useRef<string>(AppState.currentState);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  // v3.5.0 — ref-mirrored callbacks so the exit listener
  // effect doesn't have to add them as deps (which would
  // cause the listener to tear down + rebuild on every
  // callback identity change).
  const playExitReplyRef = useRef<(() => Promise<void>) | null>(null);
  const addVoiceLogRef = useRef<((s: string) => void) | null>(null);
  // v3.2.17 — ref-captured reference to the latest
  // startRecordingTurn closure, so the onAudioResponse
  // handler can re-enter the multi-turn loop without
  // going through the wake-word matcher again.
  const startRecordingTurnRef = useRef<(() => Promise<void>) | null>(null);
  // v3.6.0 — ref-captured reference to the latest
  // stopAndSendRecording closure, so the owwSendDetected
  // listener can call it without needing to track the
  // callback identity as a useEffect dep.
  const stopAndSendRecordingRef = useRef<((trigger: 'silence' | 'send') => Promise<void>) | null>(null);
  // v3.2.20 — transcribing-state timeout. Set when audio
  // is sent, cleared when a chat/audio_response event arrives
  // (or when voice mode exits).
  const transcribingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v3.6.0 — flag tracking whether the active recording
  // turn has crossed the speech-activity threshold at least
  // once. Used by stopAndSendRecording to drop "gibberish"
  // recordings (pure background noise, table conversation
  // not aimed at the assistant, etc) before they reach the
  // STT pipeline. Reset to false at the start of each
  // recording turn.
  const speechDetectedDuringRecordingRef = useRef<boolean>(false);
  // v3.6.0 — guards against double-fire when two end-of-
  // turn triggers (silence timer + send word) race for the
  // same recording. Set true the moment stopAndSendRecording
  // begins; subsequent calls bail. Reset at the start of
  // each recording turn.
  const stopInFlightRef = useRef<boolean>(false);

  const [voiceStatus, setVoiceStatus] = useState<string>(voiceMode ? 'listening' : 'listening');
  const [voiceLogs, setVoiceLogs] = useState<string[]>([]);
  // v3.1.80: two-phase wake. When Wake Mode opens (NOT
  // voice mode), we play the greeting first and the wake
  // listener stays muted until the greeting is done. The
  // user then says the wake word again to begin recording.
  // This is the standard two-step wake pattern (Siri /
  // Alexa / Google Assistant) and avoids the previous
  // bug where the mic would pick up the system's own
  // greeting TTS and either false-positive or saturate
  // the matcher.
  const [greetingPhase, setGreetingPhase] = useState<'playing' | 'done' | 'skipped'>(
    voiceMode ? 'skipped' : 'playing',
  );
  const [webViewKey, setWebViewKey] = useState(0);

  // v3.1.89: keep last 5 log lines so the WebView fallback
  // decision and the Speaking / Greeting / Matching prelude
  // are all visible at once. Previously only the last 3 were
  // shown, which hid the Speaking call and made it impossible
  // to tell whether speak() was reached at all.
  // v3.2.24 — dedupe consecutive identical entries. The
  // voice log used to compound the same message every time
  // the desktop broadcast a chat_message (Tobe saw 5 copies
  // of the same joke in a row). Now we drop an entry if it
  // duplicates the previous one. Also cap at 6 entries so the
  // overlay doesn't overflow on small phones.
  const addVoiceLog = useCallback((text: string) => {
    setVoiceLogs(prev => {
      const next = prev.length > 0 && prev[prev.length - 1] === text ? prev : [...prev, text];
      return next.slice(-6);
    });
  }, []);
  addVoiceLogRef.current = addVoiceLog;

  // Speak via native TTS (works even when AudioRecord is active).
  //
  // v3.1.87: when WebView fallback fires, also call
  // stopSpeaking() to cancel any pending native TTS. The two
  // paths were racing — native TTS init could complete
  // ~700ms after start, around the same time the WebView
  // fallback fires, and then both paths would try to speak
  // simultaneously. The user would either hear garbled
  // audio (two TTS engines competing) or no audio at all
  // (audio focus contention). Cancelling native when the
  // WebView fallback fires makes the WebView path the
  // authoritative speaker once the fallback decision is
  // made.
  //
  // Also: increased the fallback delay from 600ms to 1500ms.
  // 600ms was too aggressive — Android's TextToSpeech init
  // commonly takes 800-1200ms on cold start, and the previous
  // value was racing past the init. With prewarmTts called
  // at App.tsx mount (v3.1.87), the engine is usually
  // already warm by the time speak() is called, and the
  // v3.1.89 fallback timeout (3500ms) gives slow devices
  // plenty of headroom without racing past the actual
  // speech.
  //
  // v3.1.89 critical fix: the v3.1.87 WebView fallback
  // called `WakeWordModule.stopSpeaking()` before
  // injecting the WebView speechSynthesis call. That was
  // KILLING any pending native TTS utterance that was
  // still in the queue (e.g. voice data finishing loading
  // or init finalising 100-500ms after speakText resolved).
  // Result: even when native TTS would have spoken a
  // moment later, we cancelled it before it could produce
  // audio. v3.1.89 removes the stopSpeaking call from the
  // fallback path. The two paths can no longer "race" for
  // audio output once the fallback decision is made,
  // because the WebView's speechSynthesis on Android is
  // almost always a no-op — so in practice the fallback
  // only adds visual noise; native TTS is the only
  // path that actually plays audio.
  const speak = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      const t0 = Date.now();
      addVoiceLog(`🔊 Speaking: "${text}"`);
      let resolved = false;
      let ttsDoneSub: { remove: () => void } | null = null;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      let estimateTimer: ReturnType<typeof setTimeout> | null = null;
      const done = (source: string) => {
        if (resolved) return;
        resolved = true;
        if (ttsDoneSub) { ttsDoneSub.remove(); ttsDoneSub = null; }
        clearTimeout(fallbackTimer);
        clearTimeout(estimateTimer);
        clearTimeout(safetyTimer);
        const elapsed = Date.now() - t0;
        addVoiceLog(`🔊 done (${source}, ${elapsed}ms)`);
        resolve();
      };
      // v3.1.85: subscribe to the native ttsDone event. The
      // WakeWordModule emits it from UtteranceProgressListener
      // onDone / onError. One-shot: we remove the listener
      // when the promise resolves.
      const emitter = getWakeWordEmitter();
      ttsDoneSub = emitter?.addListener('ttsDone', () => done('native')) ?? null;

      const speakViaWebView = () => {
        // v3.1.89: do NOT call stopSpeaking() here. We
        // used to kill any pending native TTS utterance
        // (see comment block above). Let native TTS keep
        // going — if it's actually working, the ttsDone
        // event will resolve done() and we'll naturally
        // skip the estimate timer.
        try {
          const escaped = text.replace(/'/g, "\\'").replace(/\n/g, ' ');
          webViewRef.current?.injectJavaScript(
            `if('speechSynthesis'in window){window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance('${escaped}');u.rate=0.95;u.pitch=1.1;window.speechSynthesis.speak(u);}true;`
          );
          addVoiceLog('🔊 (webview fallback)');
          // v3.1.89: estimate bumped from 80ms/char to
          // 100ms/char with a 2000ms minimum. The WebView
          // speechSynthesis API on Android is unreliable
          // (often a no-op), so when this path runs we're
          // usually just waiting for native TTS to actually
          // start speaking (which ttsDone will resolve
          // first). The longer estimate ensures we don't
          // double-log "done" prematurely.
          const estimateMs = Math.min(6000, Math.max(2000, text.length * 100));
          estimateTimer = setTimeout(() => done('webview-estimate'), estimateMs);
        } catch (_) {
          addVoiceLog('🔊 ❌ both TTS paths failed');
          done('failed');
        }
      };

      // v3.1.89: 8-second safety. Native TTS on slow
      // devices + cold voice data load can take up to
      // 5-6 seconds for the first utterance after a wake
      // event. The previous 5s safety was firing before
      // ttsDone had a chance to arrive, which then masked
      // the actual completion (we'd report "done (safety)"
      // and skip ttsDone).
      const safetyTimer = setTimeout(() => done('safety'), 8000);

      if (WakeWordModule?.speakText) {
        // v3.1.89: fallback timeout 1500ms → 3500ms. The
        // earlier 1500ms was tuned for native TTS that
        // finishes in 800-1200ms, but on Tobe's device the
        // post-wake cold-start can take 2-3s before
        // ttsDone fires. 1500ms was firing the fallback
        // every time, even when native TTS was about to
        // produce audio. 3500ms gives native plenty of time
        // while still letting the WebView fallback catch
        // genuine native-TTS failures.
        fallbackTimer = setTimeout(() => {
          if (!resolved) {
            addVoiceLog('🔊 native TTS slow, falling back');
            speakViaWebView();
          }
        }, 3500);
        WakeWordModule.speakText(text).then(() => {
          // v3.1.89: log the native promise resolution.
          // speakText resolves as soon as engine.speak() is
          // called, NOT when speech actually starts. The
          // elapsed time from t0 tells us how long native
          // took to enqueue the utterance (which is also a
          // useful "is native TTS healthy?" signal).
          addVoiceLog(`🔊 native enqueued (${Date.now() - t0}ms)`);
        }).catch((err: any) => {
          if (!resolved) {
            // v3.1.90: special-case the "no TTS engine"
            // error so the user sees a clear, actionable
            // message instead of a generic native-failed
            // log. status=-1 from the TTS init listener
            // means the device has no TTS engine binding
            // — the most common cause on stripped Android
            // skins or devices where the user uninstalled
            // the default engine.
            const code = err?.code || '';
            if (code === 'TTS_INIT_FAILED' && /status=-1/.test(err?.message || '')) {
              addVoiceLog('🔊 ❌ no TTS engine — install one');
              // Don't bother with the WebView fallback
              // here — speechSynthesis is also a no-op on
              // these devices. Just resolve immediately
              // so the listener can start.
              done('no-tts-engine');
              return;
            }
            addVoiceLog(`🔊 native failed: ${err?.message || err}`);
            clearTimeout(fallbackTimer);
            speakViaWebView();
          }
        });
      } else {
        speakViaWebView();
      }
    });
  }, []);

  // v3.1.91: play a cached greeting audio file (WAV
  // synthesized by the desktop's piper TTS). Resolves
  // when the file finishes playing OR after a safety
  // timeout, whichever comes first. Uses
  // WakeWordModule.startPlayer which emits
  // audioPlayerFinished on completion.
  const playCachedGreeting = useCallback(async (filePath: string): Promise<void> => {
    if (!WakeWordModule?.startPlayer) {
      addVoiceLog('🔊 cached play: startPlayer unavailable');
      return;
    }
    const t0 = Date.now();
    let resolved = false;
    const finish = (source: string) => {
      if (resolved) return;
      resolved = true;
      if (sub) sub.remove();
      clearTimeout(safetyTimer);
      addVoiceLog(`🔊 done (cached-${source}, ${Date.now() - t0}ms)`);
    };
    let sub: { remove: () => void } | null = null;
    const emitter = getWakeWordEmitter();
    sub = emitter?.addListener('audioPlayerFinished', () => finish('play')) ?? null;
    // Safety: max 10s for the greeting. Cache files
    // are typically 1-3s.
    const safetyTimer = setTimeout(() => finish('safety'), 10000);
    try {
      await WakeWordModule.startPlayer(filePath);
    } catch (e: any) {
      addVoiceLog(`🔊 cached play failed: ${e?.message}`);
      finish('error');
    }
  }, []);

  // v3.2.29: play the exit reply on voice-mode close.
  // Mirror of the wake greeting flow: read the phrase
  // from AsyncStorage, try the cached WAV first, fall
  // back to speak() (which uses local TTS). Fire-and-
  // forget — the close happens regardless of whether
  // the audio actually starts. Empty phrase = silent
  // close (no audio, no log spam).
  //
  // Why fire-and-forget: the user is leaving voice mode
  // and dropping back to passive wake listening. We
  // want the goodbye to overlap with the transition, not
  // hold the screen open for a few seconds. The local
  // TTS engine will start producing audio within ~50ms;
  // the user hears the start of the phrase as the screen
  // fades. A 250ms kick-off delay gives the audio a
  // chance to start before the close, so the user doesn't
  // miss the first syllable.
  const playExitReply = useCallback(async (): Promise<void> => {
    let phrase = '';
    try {
      phrase = await AsyncStorage.getItem('cyberclaw-exit-reply-phrase') || '';
    } catch (_) {}
    if (!phrase || !phrase.trim()) {
      // Silent close. Don't even log — the user has
      // explicitly cleared the field.
      return;
    }
    const trimmed = phrase.trim();
    // Try cached audio first.
    try {
      const { getCachedExitReplyPath } = require('../services/ExitReplyAudioCache');
      const cached = await getCachedExitReplyPath(trimmed);
      if (cached) {
        addVoiceLog(`🔊 exit reply (cached): "${trimmed}"`);
        // Fire-and-forget: kick off the play but don't
        // block the close. The audio runs to completion
        // in the background.
        playCachedGreeting(cached).catch(() => {});
        return;
      }
      // No cache — request a synthesis (fire-and-forget)
      // AND speak the phrase now as a fallback so the
      // user hears something immediately. The next
      // close will use the warmed cache.
      const { ensureExitReplyCached } = require('../services/ExitReplyAudioCache');
      ensureExitReplyCached(trimmed).catch(() => {});
      addVoiceLog(`🔊 exit reply (TTS fallback): "${trimmed}"`);
      speak(trimmed).catch(() => {});
    } catch (e: any) {
      // If anything in the cache module errors out, fall
      // back to local TTS so the user still hears
      // something.
      addVoiceLog(`🔊 exit reply (TTS fallback, error): "${trimmed}"`);
      speak(trimmed).catch(() => {});
    }
  }, [speak]);
  playExitReplyRef.current = playExitReply;

  // v3.10.13: play the user's chosen turn-cue sound and
  // wait for it to finish. Used by both the
  // response-complete path (afterPlayback in onAudioResponse)
  // and the no-response-retry path (transcribingTimeout in
  // stopAndSendRecording) so the user always gets audio
  // feedback that their turn is starting, regardless of
  // whether the desktop responded.
  //
  // Tobe's v3.10.12 feedback: "This time it failed to
  // respond for some reason and again it continued the
  // conversation Instead of retrying. And when it was
  // the user turn it did not make the cue sound either."
  // The second part is the relevant bug here — when the
  // desktop times out, afterPlayback never fires (no audio
  // = no audioPlayerFinished = no cue). The user transitions
  // to a new recording turn silently. Calling this function
  // from the no-response retry path fixes that.
  //
  // Implementation notes (lifted from the inline block in
  // afterPlayback):
  // - Reads the cue setting fresh each call (user may
  //   change it during the response)
  // - Waits for audioPlayerFinished OR a 3s safety timeout
  // - Resolves on either: cue played to completion OR
  //   cue failed OR 3s elapsed
  const playTurnCueAndWait = useCallback(async (): Promise<void> => {
    try {
      const { TURN_CUE_KEY, DEFAULT_TURN_CUE } = require('../services/VoiceSettings');
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const cue = (await AsyncStorage.getItem(TURN_CUE_KEY)) || DEFAULT_TURN_CUE;
      if (!cue || cue === 'off') return;
      const path = `file:///android_asset/sounds/turn-${cue}.wav`;
      addLogEntry(`🔔 Turn cue: ${cue}`, 'debug');
      let cueFinished = false;
      const cueSub = wakeWordEmitter?.addListener('audioPlayerFinished', () => {
        cueFinished = true;
      });
      WakeWordModule?.startPlayer?.(path)?.catch((e: any) => {
        addLogEntry(`Turn cue play failed: ${e?.message || e}`, 'warn');
        cueFinished = true;
      });
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const tick = setInterval(() => {
          if (cueFinished || Date.now() - start > 3000) {
            clearInterval(tick);
            resolve();
          }
        }, 50);
      });
      cueSub?.remove?.();
    } catch (_) {}
  }, []);

  // v3.2.20 — clear the transcribing-timeout on unmount so a
  // stale timer can't fire after the user has already left
  // voice mode.
  useEffect(() => {
    return () => {
      if (transcribingTimeoutRef.current) {
        clearTimeout(transcribingTimeoutRef.current);
        transcribingTimeoutRef.current = null;
      }
    };
  }, []);

  // Apply Wake Mode visual style to the WebView. We do this once on
  // mount and on every load. Unlike the HomeScreen approach (which
  // races state updates), this screen ALWAYS renders in wake mode so
  // the visual style is stable.
  useEffect(() => {
    const applyWakeModeClass = () => {
      try {
        webViewRef.current?.injectJavaScript(`
          document.getElementById('ui')?.classList.add('fullscreen');
          document.getElementById('ui')?.classList.add('wake-mode');
          document.getElementById('c')?.classList.add('fullscreen');
          document.body.classList.add('fullscreen');
          document.documentElement.classList.add('fullscreen');
          true;
        `);
      } catch (_) {}
    };
    applyWakeModeClass();
    const t1 = setTimeout(applyWakeModeClass, 200);
    const t2 = setTimeout(applyWakeModeClass, 600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [webViewKey]);

  // v3.1.59: inject setAgents into the WebView on mount so the
  // companion is drawn. The home screen's WebView had setAgents
  // injected on every agents_list broadcast, but the wake mode
  // WebView is a separate instance with an empty companions array.
  // Without this, the companion is missing from wake mode.
  //
  // v3.2.18: the wake-mode WebView is now THE WebView for voice
  // mode (Wake Mode is gone). It mounts on every voice-mode
  // entry. agents can be empty when WakeModeScreen first mounts
  // (App.tsx loads them async from AsyncStorage), so we retry
  // injectAgents every 200ms for up to 5s until agents arrive.
  // If agents never arrive (e.g. disconnected from desktop),
  // the screen still works — it just has no companion sprite.
  useEffect(() => {
    let cancelled = false;
    const injectAgents = () => {
      if (cancelled) return;
      if (agents.length === 0) return;
      try {
        const slim = agents.map((a) => ({
          id: a.id, name: a.name, sprite: a.sprite || null, scale: a.scale || null,
        }));
        webViewRef.current?.injectJavaScript(
          `window.Arena && window.Arena.setAgents(${JSON.stringify(slim)}); true;`,
        );
      } catch (_) {}
    };
    injectAgents();
    const t1 = setTimeout(injectAgents, 200);
    const t2 = setTimeout(injectAgents, 500);
    const t3 = setTimeout(injectAgents, 1500);
    // Long retry loop: every 1s for 5s, in case agents
    // arrives late (cold launch from cold-boot).
    let attempts = 0;
    const retry = setInterval(() => {
      if (cancelled || ++attempts > 5) return;
      injectAgents();
    }, 1000);
    return () => {
      cancelled = true;
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      clearInterval(retry);
    };
  }, [agents, webViewKey]);

  // Keep screen on while in Wake Mode
  useEffect(() => {
    AppControl?.keepScreenOn?.(true);
    return () => {
      AppControl?.keepScreenOn?.(false);
    };
  }, []);

  // v3.2.17 — voice-mode mount: skip the wake listener entirely
  // and go straight to recording. The wake word has ALREADY
  // fired to open this screen (App.tsx swapped to voice-mode
  // on onWakeMatch), so waiting for ANOTHER wake match here
  // would just leave the user staring at "Listening for wake
  // word..." while they speak their actual command. That's the
  // v3.2.16 B bug: the screen mounted in voice-mode and started
  // a DTW wake listener, then waited forever for a second
  // wake phrase that will never come. Fix: voice-mode = record
  // immediately, then loop. The `handleWakeWordInner` path is
  // reserved for Wake Mode only now.
  useEffect(() => {
    if (voiceMode) {
      (async () => {
        addLogEntry('🎤 Voice Mode: starting', 'info');
        // v3.2.18 — play the greeting before the first
        // recording turn. Previously the greeting lived
        // inside the wake-listener-start useEffect, which
        // now early-returns for voice mode. Without this
        // copy the user sees "Listening..." with no
        // greeting audio (which Tobe reported on v3.2.18:
        // "Now it skipped right to listen without
        // greeting"). Reading the same `cyberclaw-ready-
        // phrase` AsyncStorage key the wake-mode path
        // used; an empty string still means "no greeting".
        let greetingText = 'Ready to chat';
        try {
          const stored = await AsyncStorage.getItem('cyberclaw-ready-phrase');
          if (stored !== null) {
            if (stored.trim() === '') {
              greetingText = '';
            } else {
              greetingText = stored;
            }
          }
        } catch (_) {}
        if (greetingText) {
          const cachedPath = await getCachedGreetingPath(greetingText);
          if (cachedPath) {
            addVoiceLog(`🔊 playing cached (${cachedPath.split('/').pop()})`);
            await playCachedGreeting(cachedPath);
          } else {
            addVoiceLog('🔊 no cached audio, requesting synthesis');
            ensureGreetingCached(greetingText).catch(() => {});
            await speak(greetingText);
          }
        }

        addLogEntry('🎤 Voice Mode: starting first recording turn', 'info');
        addVoiceLog('🎤 Listening...');
        setVoiceStatus('listening');
        // Mark busy so onAudioResponse's afterPlayback doesn't
        // think we're idle. startRecordingTurn sets/clears this
        // itself on silence_event end. For the FIRST turn we
        // also need it set here so the multi-turn loop gating
        // in onAudioResponse treats the screen as busy until
        // the user finishes their first utterance.
        wakeWordBusyRef.current = true;
        try {
          await startRecordingTurn();
        } catch (e: any) {
          addLogEntry(`Voice Mode first-turn failed: ${e?.message}`, 'error');
          wakeWordBusyRef.current = false;
        }
      })();
      return;
    }
  }, [voiceMode]);

  // Start the sample-match wake listener. When matched, start recording.
  // v3.1.93: voiceMode is now IDENTICAL to wake mode — both
  // run the sample-matcher first, then on match play a short
  // beep, then record. Pre-v3.1.93, voiceMode skipped the
  // wake listener and went straight to VAD + recording (no
  // wake phrase needed). After Tobe's request to fold wake
  // detection into voice mode ("remove wake mode, add wake
  // phrase to voice mode"), both modes do the same thing.
  // The `voiceMode` prop still affects UI styling but no
  // longer the wake-listener path.
  //
  // v3.2.17: voice mode is handled by the effect ABOVE; this
  // wake-listener effect is now Wake Mode only (voiceMode=false).
  useEffect(() => {
    if (voiceMode) return; // handled above
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        // v3.1.67: per-companion wake training. Load all
        // companions' training data (keyed by companion ID,
        // not phrase) and match against all of them. When
        // a match fires, the matched companionId is sent
        // to App.tsx so the wake mode shows the right one.
        // Falls back to the old single-phrase format if no
        // per-companion data exists.
        const allKeys = await AsyncStorage.getAllKeys();
        const sampleKeys = allKeys.filter(k => k.startsWith('cyberclaw-wake-samples-'));
        const companionsTraining = [];
        for (const key of sampleKeys) {
          try {
            const raw = await AsyncStorage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (parsed?.features?.length) {
              const companionId = key.replace('cyberclaw-wake-samples-', '');
              companionsTraining.push({ companionId, features: parsed.features });
            }
          } catch (_) {}
        }

        if (cancelled) return;

        if (companionsTraining.length > 0) {
          addLogEntry(`🎤 Wake Mode active — listening for ${companionsTraining.length} companion wake word(s)`, 'info');
          addVoiceLog('🔊 Greeting...');
          setVoiceStatus('greeting');
          for (const c of companionsTraining) {
            const comp = c.companionId;
            addVoiceLog(`Matching: ${comp}`);
          }

          // v3.1.91: pre-warm the greeting cache BEFORE
          // the wake event fires. The synthesis request
          // takes 2-5s on the desktop, so doing it at
          // Wake Mode open time means the cache is
          // (usually) ready by the time the user actually
          // says the wake word. Without this, the first
          // wake event after install gets a no-tts-engine
          // log and silent audio; the user has to wait
          // for the second wake event to actually hear
          // the greeting. With pre-warm, the very first
          // wake event can use the freshly-cached audio.
          // The greetingText value is read later in this
          // same effect, so we read it once here to share
          // the AsyncStorage hit (and to log "no phrase"
          // if the user disabled greetings).
          let prewarmPhrase = 'Ready to chat';
          try {
            const stored = await AsyncStorage.getItem('cyberclaw-ready-phrase');
            if (stored !== null) {
              prewarmPhrase = stored;
            }
          } catch (_) {}
          if (prewarmPhrase && prewarmPhrase.trim()) {
            // Fire-and-forget: log whether a cache
            // already exists so the user can see in the
            // voice log whether synthesis is needed.
            const prewarmCached = await getCachedGreetingPath(prewarmPhrase);
            if (prewarmCached) {
              addVoiceLog(`🔊 greeting cached ✓ (${prewarmCached.split('/').pop()})`);
            } else {
              addVoiceLog(`🔊 pre-warming greeting via desktop...`);
              ensureGreetingCached(prewarmPhrase).catch(() => {});
            }
          }

          // v3.1.80 / v3.1.85: two-phase wake. Play the
          // greeting first, then start the listener after
          // the greeting actually finishes speaking. The
          // native AudioRecord stays OFF during the
          // greeting, so the system TTS isn't picked up
          // by the matcher.
          //
          // Tobe (v3.1.85): "perhaps we need some delay?"
          // — yes, but not a fixed delay. The v3.1.80
          // approach used a 1500ms setTimeout (the typical
          // "Ready to chat" native-TTS duration). That was
          // too short for the WebView speechSynthesis
          // fallback path, which has longer queue/synthesis
          // overhead. Result: greeting got cut off
          // mid-utterance when AudioRecord stole audio
          // focus at T=1500ms.
          //
          // v3.1.85 replaces the fixed delay with
          // `await speak()` — the speak() Promise resolves
          // when TTS actually finishes (native ttsDone
          // event, or estimated duration for WebView
          // fallback, or a 5s safety timeout). The
          // listener doesn't start until the greeting is
          // done, so it can no longer cut the audio off.
          //
          // The user-configured `cyberclaw-ready-phrase`
          // controls what gets said; empty string disables
          // the greeting entirely.
          //
          // v3.1.88: the legacy `greetingMs` variable is
          // removed. It was used to drive a setTimeout in
          // the v3.1.80 two-phase wake, and to gate
          // `speak()` via `if (greetingMs > 0 && greetingText)`.
          // In v3.1.85 the setTimeout was replaced with
          // `await speak()`, but the `greetingMs > 0` gate
          // stayed — and since the new default was 0,
          // speak() was silently NEVER called. Tobe
          // reported "still no wake greeting sound" for
          // v3.1.85 / v3.1.86 / v3.1.87. Now speak() is
          // gated on `if (greetingText)` only, which is
          // false only when the user explicitly set
          // `cyberclaw-ready-phrase` to an empty string.
          let greetingText = 'Ready to chat';
          try {
            const stored = await AsyncStorage.getItem('cyberclaw-ready-phrase');
            if (stored !== null) {
              if (stored.trim() === '') {
                // User disabled the greeting — skip
                // speaking entirely.
                greetingText = '';
              } else {
                greetingText = stored;
              }
            }
          } catch (_) {}
          // v3.1.49: read the user-configured FG threshold
          // from settings. Defaults to 0.55 if not set.
          // Read FRESH here so a change made during the
          // greeting delay takes effect immediately when
          // the listener starts.
          // v3.10.7: lowered default from 0.55 → 0.5 to
          // match the SAMPLE_MATCH_THRESHOLD_FG constant.
          // Tobe's v3.10.6 feedback: "the wake should
          // perhaps be more sensitive, some times,
          // perhaps only shortly after startup i have
          // to almost yell". Lowering the threshold
          // makes OWW trigger on slightly weaker
          // evidence — for a custom-trained wake model
          // (which is the only model we use) the score
          // distribution is tight, so 0.5 still keeps
          // false positives low. The auto-tightening
          // bump from false-open tracking still applies
          // on top, so the user can't accidentally
          // crash it by lowering further.
          const fgThreshold = parseFloat(
            (await AsyncStorage.getItem('cyberclaw-wake-fg-threshold')) || '0.5',
          );
          // v3.1.85: await the speak() Promise so the
          // listener doesn't start until the greeting
          // actually finishes. Previously we used a fixed
          // 1500ms setTimeout, which was the typical
          // native-TTS duration. But the WebView fallback
          // path is slower (queue overhead, longer actual
          // utterance synthesis) and the 1500ms cap was
          // cutting the greeting off mid-utterance as soon
          // as AudioRecord stole audio focus.
          //
          // speak() also has its own 5s safety timeout
          // (returns from the Promise after 5s no matter
          // what), so a stuck TTS never hangs the listener
          // start.
          //
          // v3.1.88 hotfix: the check used to be
          // `if (greetingMs > 0 && greetingText)`. In
          // v3.1.85 I changed the default greetingMs from
          // 1500 to 0 (comment: "no longer drives a
          // setTimeout") and didn't update this check, so
          // speak() was silently NEVER called — the
          // greeting was always skipped, regardless of
          // whether the user had a custom phrase. Tobe
          // reported "still no wake greeting sound" for
          // v3.1.85 / v3.1.86 / v3.1.87. The check is now
          // `if (greetingText)` — only the empty-string
          // case (which sets greetingText='') skips
          // speaking. The greetingMs variable is no
          // longer needed at all (kept as a no-op for
          // clarity, will be removed in a future cleanup).
          if (greetingText) {
            // v3.1.91: try cached desktop-synthesized
            // audio first. On devices with no native TTS
            // engine (status=-1 from OnInitListener), the
            // native speakText path is permanently broken
            // — using cached audio side-steps the whole
            // problem. If no cache exists, fall through to
            // speakText (which logs no-tts-engine clearly
            // when the engine is missing) and kick off a
            // background synthesis request so the NEXT
            // wake event has a cache to use.
            const cachedPath = await getCachedGreetingPath(greetingText);
            if (cachedPath) {
              addVoiceLog(`🔊 playing cached (${cachedPath.split('/').pop()})`);
              await playCachedGreeting(cachedPath);
            } else {
              addVoiceLog('🔊 no cached audio, requesting synthesis');
              // Kick off background synthesis for next time.
              ensureGreetingCached(greetingText).catch(() => {});
              await speak(greetingText);
            }
          }
          if (cancelled) return;
          setGreetingPhase('done');
          setVoiceStatus('listening');
          addVoiceLog('🎧 Listening for wake word...');
          cleanup = startSampleMatchListener(
            companionsTraining,
            handleWakeWordInner,
            (msg) => addLogEntry(msg, 'debug'),
            fgThreshold,
          );
          sampleListenerCleanupRef.current = cleanup;
        } else {
          addLogEntry('No training data for sample match — open Wake Mode and tap "Train wake phrase" to record 3 samples.', 'error');
        }
      } catch (e: any) {
        addLogEntry(`Wake listener start failed: ${e?.message}`, 'error');
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
      sampleListenerCleanupRef.current = null;
    };
  }, []);

  // When a wake match fires inside Wake Mode, start recording
  // v3.1.67: takes the matched companionId from the matcher
  // so we can update App.tsx's active companion.
  const handleWakeWordInner = useCallback(async (matchedCompanionId?: string) => {
    if (wakeWordBusyRef.current) return;
    wakeWordBusyRef.current = true;
    setVoiceStatus('listening');
    addLogEntry(`🎤 Wake word matched for ${matchedCompanionId || 'unknown'} - recording`, 'info');
    addVoiceLog('🎤 Listening...');

    // v3.1.93 (reverted): an 880Hz audio beep was added
    // here as wake-word confirmation. Tobe: "we dont need
    // audio beep on wake detection. the wake greetings is
    // that function." The greeting spoken at wake match IS
    // the audio confirmation — e.g. "Greetings master Toby"
    // is much more useful than a generic beep. Removed.

    // v3.1.67: tell the parent (App.tsx) which companion
    // matched so it can update the active companion and
    // the wake mode shows the right one.
    if (matchedCompanionId) {
      onWakeMatch?.(matchedCompanionId);
    }

    sampleListenerCleanupRef.current?.();
    sampleListenerCleanupRef.current = null;

    await startRecordingTurn();
  }, []);

  // v3.6.0 — shared stop-and-send path. Both the silence
  // timer (auto-send after `silenceMs` of quiet) and the
  // send-word detector (explicit "I'm done with my turn"
  // cue) call into this. triggerReason is one of
  // 'silence' | 'send' — used only for logging.
  //
  // The function is idempotent within a recording turn:
  // the stopInFlightRef guard rejects concurrent calls so a
  // send-word match can't fire while the silence timer is
  // mid-countdown (or vice versa). The first caller wins.
  //
  // Empty-recording handling covers two cases:
  //   1. The recorder produced a tiny file (base64 < 100
  //      chars) — the native recorder was probably still
  //      warming up. Treat as no-op.
  //   2. The recording was long enough but VAD never crossed
  //      the speech threshold during the turn (speechDetected-
  //      DuringRecordingRef stayed false) — this is the
  //      "gibberish" case Tobe reported: app kept recording
  //      table conversation and sent garbage to the LLM.
  //      Now we drop it and loop the recording turn in
  //      voice mode (or sit idle in wake mode).
  const stopAndSendRecording = useCallback(async (triggerReason: 'silence' | 'send') => {
    if (stopInFlightRef.current) return;
    stopInFlightRef.current = true;
    const recorder = getSimpleAudioRecorder();
    // v3.9.6 — always clear the silence listener + countdown
    // interval at the top of stopAndSendRecording. Covers all
    // paths: silence-fired (already auto-unsubscribed by
    // `once`, but the JS countdown interval might still be
    // ticking), send-word (turn ended early, listener and
    // interval still pending), no-speech skip (same). Without
    // this, listeners and intervals accumulate across turns
    // and a later silence event cuts everything off fast.
    silenceUnsubRef.current?.();
    silenceUnsubRef.current = null;
    if (silenceCountdownIntervalRef.current != null) {
      clearInterval(silenceCountdownIntervalRef.current);
      silenceCountdownIntervalRef.current = null;
    }
    // v3.10.9: reset silence-fired so a future recording
    // turn can fire the countdown again. Without this the
    // ref could carry over across turns if stopAndSendRecording
    // was bypassed (e.g. early returns).
    silenceFiredRef.current = false;
    // v3.9.2 — voiceStatus reset helper for early-return branches.
    // The state was getting stuck on 'silence_countdown' (the
    // "⏳ Sending..." overlay) after the gibberish-gate skip and
    // similar no-send paths, because those branches cleared
    // wakeWordBusyRef/stopInFlightRef but never reset the
    // overlay state. Tobe hit this in v3.9.1: silence → skip →
    // restart → silence again → skip → overlay stuck on "Sending"
    // forever while the log showed "Still listening".
    const resetVoiceStatus = () => {
      // Only reset if we're in a transient state that wouldn't
      // otherwise be cleared. Don't clobber 'greeting' or
      // 'responding' (those are owned by other handlers).
      setVoiceStatus(prev =>
        prev === 'silence_countdown' || prev === 'transcribing'
          ? 'listening'
          : prev
      );
    };
    try {
      let resultPath: string;
      try {
        resultPath = await recorder.stop();
      } catch (e: any) {
        addLogEntry(`Wake Mode: stop() failed (${triggerReason}): ${e?.message}`, 'error');
        wakeWordBusyRef.current = false;
        stopInFlightRef.current = false;
        resetVoiceStatus();
        return;
      }
      if (!resultPath) {
        addLogEntry('Wake Mode: no recording path', 'error');
        wakeWordBusyRef.current = false;
        stopInFlightRef.current = false;
        resetVoiceStatus();
        return;
      }
      const fs = require('react-native-fs');
      const stats = await fs.stat(resultPath);
      addLogEntry(`Wake Mode: audio file ${stats.size} bytes`, 'info');
      const base64 = await fs.readFile(resultPath, 'base64');
      addLogEntry(`Wake Mode: base64 ${base64.length} chars`, 'info');
      // Tiny file = recorder didn't actually capture anything.
      if (base64.length < 100) {
        addLogEntry('Wake Mode: base64 too small, treating as empty', 'error');
        wakeWordBusyRef.current = false;
        stopInFlightRef.current = false;
        resetVoiceStatus();
        if (voiceMode) {
          addVoiceLog('🎤 No speech, still listening...');
          startRecordingTurnRef.current?.().catch(() => {});
        }
        return;
      }
      // v3.6.0 — gibberish gate. If VAD never saw speech in
      // this turn, the recording is just background noise /
      // ambient table talk. Don't send it to STT. This is
      // the v3.5.2 fix for Tobe's "talk around the table"
      // bug: the app used to keep recording indefinitely
      // and ship silence to the desktop which then got
      // hallucinated into a response.
      if (!speechDetectedDuringRecordingRef.current) {
        addLogEntry(`Wake Mode: no speech detected (${triggerReason}), dropping`, 'info');
        addVoiceLog('🔇 No speech detected, skipping…');
        wakeWordBusyRef.current = false;
        stopInFlightRef.current = false;
        resetVoiceStatus();
        if (voiceMode) {
          addVoiceLog('🎤 Still listening...');
          startRecordingTurnRef.current?.().catch(() => {});
        }
        return;
      }
      setVoiceStatus('transcribing');
      syncClient.sendAudioInput(base64, 'audio/wav');
      addLogEntry(`Wake Mode: audio sent for transcription (trigger=${triggerReason})`, 'sent');
      addVoiceLog(triggerReason === 'send' ? '📤 Send word → sent' : '📏 Sent, waiting...');

      // v3.2.20 — transcribing timeout. If the desktop
      // doesn't respond within 30s (network stall, STT
      // hang, LLM outage, etc), give up and either start
      // a new recording turn (voice mode loop) or close
      // voice mode (no point staying). This prevents the
      // user from being permanently stuck on "Transcribing..."
      // when the desktop pipeline is jammed. Tobe reported
      // this exact symptom in v3.2.19.
      transcribingTimeoutRef.current = setTimeout(() => {
        if (wakeWordBusyRef.current) {
          addLogEntry('⏰ Transcribing timeout (30s) — no response from desktop', 'error');
          addVoiceLog('⏰ No response, retrying...');
          wakeWordBusyRef.current = false;
          // v3.10.7: show a "retrying" status instead of
          // jumping straight to "listening" / YOUR TURN.
          // Tobe's v3.10.6 feedback: "If its trying again
          // it should not be your turn." During the retry
          // window (we're about to call startRecordingTurn
          // which itself takes a moment), the overlay
          // should reflect "we're waiting, not yet
          // listening". The status clears to 'listening'
          // automatically when the next recording turn
          // starts (via setVoiceStatus('listening') inside
          // startRecordingTurn). This avoids a flash of
          // YOUR TURN during the gap between "retrying"
          // and the next recording window opening.
          setVoiceStatus('retrying');
          // Keep resetVoiceStatus behavior for safety
          // (e.g. startRecordingTurn fails and we leave
          // the state inconsistent). resetVoiceStatus
          // only downgrades 'silence_countdown' or
          // 'transcribing' to 'listening'; for
          // 'retrying' we need an explicit clear.
          // Done below in the startRecordingTurn
          // promise chain.
          if (voiceMode) {
            // Start a new recording turn so the loop
            // continues. The user can keep talking.
            //
            // v3.10.13: play the turn cue BEFORE opening
            // the new recording window so the user gets
            // audio feedback that "it's your turn again".
            // Previously the cue only played on the
            // successful-response path (via afterPlayback);
            // on a no-response retry there was no cue
            // because audioPlayerFinished never fired.
            playTurnCueAndWait().then(() => {
              startRecordingTurnRef.current?.()
                .then(() => {
                  // startRecordingTurn sets 'listening'
                  // internally; nothing to do.
                })
                .catch(() => {
                  // If the new turn couldn't start,
                  // clear the retrying state so the
                  // overlay doesn't get stuck.
                  setVoiceStatus('listening');
                });
            }).catch(() => {
              // If the cue itself failed, still try to
              // start the recording turn.
              startRecordingTurnRef.current?.().catch(() => {
                setVoiceStatus('listening');
              });
            });
          }
        }
      }, 30000);

      // v3.2.17 — voice-mode exit-phrase check.
      // After sending, watch the next incoming chat
      // message from the desktop; if its userText
      // (the STT transcription) contains an exit
      // phrase, close voice mode instead of looping
      // into the next recording turn. The desktop
      // emits a chat message containing the user's
      // transcribed text alongside the assistant's
      // response. We poll briefly (max 6s) for it.
      if (voiceMode) {
        pollForExitPhrase().catch(() => {});
      }
    } catch (e: any) {
      addLogEntry(`Wake Mode: send error (${triggerReason}): ${e?.message}`, 'error');
      wakeWordBusyRef.current = false;
    } finally {
      // The stop-and-send attempt is over. Do NOT clear
      // stopInFlightRef here if we successfully sent —
      // the next recording turn (started by the response
      // handler or the multi-turn loop) resets it.
      // The next-turn reset happens in startRecordingTurn.
    }
  }, [voiceMode]);

  // v3.2.17 — start a recording turn. Used both on wake match
  // (first call from handleWakeWordInner) and on each
  // multi-turn loop iteration (subsequent calls from the
  // response handler). Reads silenceMs fresh so a Settings
  // change takes effect on the NEXT turn without a mode
  // restart.
  //
  // v3.6.0: also resets speechDetectedDuringRecordingRef and
  // stopInFlightRef so the gibberish gate and the
  // double-fire guard are fresh for each turn.
  const startRecordingTurn = useCallback(async () => {
    // v3.10.7: clear any transient 'retrying' state
    // (or any other stuck transient) before opening the
    // new recording window. Without this, the overlay
    // would stay on "Retrying..." even after the
    // recorder is live, because startRecordingTurn
    // doesn't call setVoiceStatus('listening') anywhere
    // internally — it relies on the silence event to
    // transition to 'silence_countdown' when the user
    // actually stops talking. For the gap between
    // recorder.start() and the first audio frame, the
    // overlay shows whatever the previous state was,
    // which is 'retrying' on the no-response retry path.
    // Flip to 'listening' here so the user sees the
    // correct "YOUR TURN" overlay as soon as the new
    // turn opens.
    setVoiceStatus('listening');
    const vad = getVAD({ sampleRate: 16000, frameSize: 512, silenceThreshold: 0.02 });
    resetVAD();
    speechDetectedDuringRecordingRef.current = false;
    // v3.10.9: reset silence-fired so the new turn can
    // fire the countdown if it sees silence. Without this
    // a turn that ends on a paused-countdown (e.g. user
    // exits voice mode mid-countdown) would suppress the
    // next turn's silence event.
    silenceFiredRef.current = false;
    stopInFlightRef.current = false;

    let silenceMs = DEFAULT_SILENCE_MS;
    try {
      // v3.4.0: load settings for THIS companion
      // (companionId prop). silenceMs is global so
      // we don't strictly need the companionId for it,
      // but pass it for consistency and so future
      // per-companion global overrides land in one
      // place.
      const settings = await loadVoiceSettings(companionId);
      silenceMs = settings.silenceMs;
    } catch (_) {}

    try {
      const fs = require('react-native-fs');
      const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-wakemode-${Date.now()}.wav`;
      const recorder = getSimpleAudioRecorder();

      // v3.9.6 — clean up any prior turn's silence listener
      // and countdown interval before registering a fresh
      // one. Prevents the listener-accumulation bug where
      // every silence event after a few turns fires all
      // accumulated listeners at once.
      silenceUnsubRef.current?.();
      silenceUnsubRef.current = null;
      if (silenceCountdownIntervalRef.current != null) {
        clearInterval(silenceCountdownIntervalRef.current);
        silenceCountdownIntervalRef.current = null;
      }

      // v3.2.17 — silence detection. The user's configured
      // silenceMs replaces the previous hardcoded 5000.
      // After continuous silence, give a 3s countdown so
      // the user can keep talking if they want; then send.
      //
      // v3.9.7 — bumped countdown from 3s to 5s. Pairs with
      // the longer silenceMs default (6s) so the total
      // "user goes silent → audio sent" window is now
      // 6s + 5s = 11s, comfortable for conversational
      // pauses including mid-thought hesitations. The 5s
      // countdown also gives a clearer visual cue
      // ("Sending in 5...") that the user can interrupt
      // by speaking again.
      //
      // v3.10.9: switched `once` → `on` and added
      // silenceFiredRef guard. The native recorder emits
      // 'recorderSilence' EVERY 80ms while silence
      // persists (the threshold gate is just `>= silenceMs`,
      // not edge-triggered), so `once` actually fires only
      // once at the boundary, but we lost the ability to
      // re-trigger the countdown if the user resumes
      // speaking during the countdown. With `on` plus the
      // guard, the countdown starts once per silence
      // period, and the owwVad listener below resets the
      // guard + clears the countdown on speech resume.
      // Net effect: "I went to the store [PAUSE 7s] to get
      // milk" no longer sends at PAUSE+5s into the
      // countdown — the user's continuation cancels the
      // countdown and waits for the NEXT silence period.
      // Matches what Tobe reported in v3.10.8:
      // "cuts me off a few seconds before my last
      // sentence finishes".
      const onSilenceEvent = async () => {
        if (silenceFiredRef.current) return;
        silenceFiredRef.current = true;
        addVoiceLog(`⏳ Silence detected (${silenceMs}ms)...`);
        addLogEntry(`Wake/Voice Mode: silence detected after ${silenceMs}ms`, 'info');
        setVoiceStatus('silence_countdown');
        let count = 5;
        const tick = setInterval(async () => {
          count--;
          if (count <= 0) {
            clearInterval(tick);
            silenceCountdownIntervalRef.current = null;
            await stopAndSendRecording('silence');
          }
        }, 1000);
        silenceCountdownIntervalRef.current = tick;
      };
      silenceUnsubRef.current = recorder.on('silence', onSilenceEvent);

      await recorder.start(recPath, silenceMs);
      recorderActiveRef.current = true;
      addLogEntry(`Wake Mode: recorder started (silence=${silenceMs}ms)`, 'info');
    } catch (e: any) {
      addLogEntry(`Wake Mode: recorder failed: ${e?.message}`, 'error');
      wakeWordBusyRef.current = false;
    }
  }, [voiceMode, stopAndSendRecording]);

  // Keep the ref updated so the response handler can call the
  // latest closure of startRecordingTurn.
  useEffect(() => {
    startRecordingTurnRef.current = startRecordingTurn;
  }, [startRecordingTurn]);
  // v3.6.0 — keep stopAndSendRecordingRef in sync so the
  // owwSendDetected listener can call the latest closure.
  useEffect(() => {
    stopAndSendRecordingRef.current = stopAndSendRecording;
  }, [stopAndSendRecording]);

  // v3.2.20 — listen for the next userText chat from the
  // desktop and check it against the single configured exit
  // phrase. Resolves as soon as either the phrase matches
  // OR a 6s window elapses. Returns the matched phrase or
  // null.
  const pollForExitPhrase = useCallback(async (): Promise<string | null> => {
    let phrase = '';
    try {
      // v3.4.0: exit phrase is now per-companion. The
      // active companion's phrase is what the runtime
      // detector runs against.
      const settings = await loadVoiceSettings(companionId);
      phrase = settings.exitPhrase;
    } catch (_) {}
    if (!phrase) return null;
    return new Promise<string | null>((resolve) => {
      const deadline = setTimeout(() => {
        syncClient.off?.('chat', onChat);
        resolve(null);
      }, 6000);
      const onChat = (m: any) => {
        if (!m?.isUser) return;
        const text = m.text || '';
        // Re-read fresh in case the user changed the phrase
        // mid-poll.
        (async () => {
          try {
            // v3.4.0: per-companion exit phrase. The
            // match runs against THIS companion's
            // active phrase.
            const s = await loadVoiceSettings(companionId);
            const matched = matchExitPhrase(text, [s.exitPhrase].filter(Boolean));
            if (matched) {
              clearTimeout(deadline);
              syncClient.off?.('chat', onChat);
              addLogEntry(`👋 Exit phrase matched: "${matched}"`, 'info');
              addVoiceLog(`👋 Exit phrase "${matched}" → closing`);
              if (voiceMode) {
                setVoiceStatus('listening');
                // v3.2.29: play the exit reply (fire-and-
                // forget) before closing. The 400ms delay
                // gives the local TTS engine a chance to
                // start producing audio before the screen
                // tears down.
                playExitReply().catch(() => {});
                setTimeout(() => exitRef.current(), 400);
              }
              resolve(matched);
            }
          } catch (_) {}
        })();
      };
      syncClient.on('chat', onChat);
    });
  }, [voiceMode]);

  // Handle audio response from desktop. In v3.2.17 there are
  // two exit routes depending on `voiceMode`:
  //   - voiceMode=false (Wake Mode):
  //     After the response audio plays, restart the wake
  //     listener so the user can say the wake phrase again.
  //     Same behavior as v3.2.16.
  //   - voiceMode=true (Voice Mode):
  //     Stay in voice mode. After the response plays, start a
  //     NEW recording turn so the user can talk again. The
  //     loop continues until: (a) silence for `silenceMs`
  //     during recording, (b) an exit phrase appears in the
  //     transcription, or (c) the user hits X / Back.
  useEffect(() => {
    const onChat = (msg: any) => {
      if (msg.isUser) return;
      // v3.2.20 — clear the transcribing timeout since we
      // got a response (the desktop pipeline is alive).
      if (transcribingTimeoutRef.current) {
        clearTimeout(transcribingTimeoutRef.current);
        transcribingTimeoutRef.current = null;
      }
      // Treat any non-user text as a wake-mode response
      addLogEntry(`💬 Wake Mode response: "${msg.text?.substring(0, 60)}..."`, 'received');
      addVoiceLog(`🔊 "${msg.text?.substring(0, 40)}..."`);
      setVoiceStatus('responding');
    };
    const onAudioResponse = async (msg: any) => {
      // Desktop sends synthesized audio. Wake Mode just lets it play.
      addLogEntry('🔊 Wake Mode: audio response from desktop', 'info');
      // v3.2.20 — clear the transcribing timeout since we
      // got a response.
      if (transcribingTimeoutRef.current) {
        clearTimeout(transcribingTimeoutRef.current);
        transcribingTimeoutRef.current = null;
      }
      // v3.2.25 — gibberish filter. If the LLM response is
      // suspiciously short AND has no terminal punctuation,
      // treat it as a nonsense reply and close voice mode
      // instead of looping the user into another recording
      // turn. Tobe's concern: an empty audio / unclear
      // speech produces a terse LLM response, and the loop
      // continues with no actual user input — the user
      // gets trapped. Heuristic: <4 words AND no '?' or '.'
      // AND no '!' → gibberish.
      if (voiceMode && msg.text) {
        const t = String(msg.text).trim();
        const wordCount = t.split(/\s+/).filter(Boolean).length;
        const hasPunctuation = /[.!?]/.test(t);
        if (wordCount < 4 && !hasPunctuation) {
          addLogEntry(
            `👋 Voice Mode: response looks like gibberish ("${t.substring(0, 40)}...") — exiting`,
            'info',
          );
          addVoiceLog(`👋 LLM gibberish → closing voice mode`);
          // v3.2.29: play the exit reply before closing.
          playExitReply().catch(() => {});
          setTimeout(() => exitRef.current?.(), 400);
          return;
        }
      }
      if (transcribingTimeoutRef.current) {
        clearTimeout(transcribingTimeoutRef.current);
        transcribingTimeoutRef.current = null;
      }
      // v3.2.21 — actually PLAY the audio. v3.2.17 was setting
      // up afterPlayback listeners but never invoking
      // startPlayer. The HomeScreen onAudioResponse handler has
      // had the correct decode+write+play pattern since
      // v3.1.91 — WakeModeScreen was missing it. Copy that
      // pattern here: write base64 to a temp file, call
      // WakeWordModule.startPlayer with the path.
      if (msg.audioBase64) {
        try {
          const fs = require('react-native-fs');
          const ext = (msg.mimeType && msg.mimeType.includes('wav')) ? 'wav' : 'mp3';
          const tmpPath = `${fs.TemporaryDirectoryPath}/cyberclaw-wakemode-response-${Date.now()}.${ext}`;
          await fs.writeFile(tmpPath, msg.audioBase64, 'base64');
          addLogEntry(`🔊 Wake Mode: audio written to ${tmpPath.split('/').pop()}, calling startPlayer`, 'info');
          await WakeWordModule?.startPlayer?.(tmpPath);
          addLogEntry('🔊 Wake Mode: startPlayer resolved', 'info');
        } catch (e: any) {
          addLogEntry(`🔊 Wake Mode: startPlayer failed: ${e?.message}`, 'error');
        }
      } else {
        addLogEntry('🔊 Wake Mode: no audioBase64 in response', 'debug');
      }
      // Track playback start so afterPlayback can wait until
      // the audio actually finishes (not just estimate).
      // v3.2.22 — the multi-turn loop used to fire
      // startRecordingTurn immediately when audioPlayerFinished
      // (or the estimated-duration timer) fired. If the user
      // took a moment to react to the response, the new
      // recorder would start and 3s of silence would fire
      // before they had time to speak. Fix: add a 1.5s
      // "let the response settle" delay before starting the
      // next recording window. The user gets a brief pause
      // to mentally prepare, the mic has time to release
      // from the playback's audio focus, and the silence
      // window starts fresh from a quiet room.
      const RESPONSE_SETTLE_DELAY_MS = 4000;
      // v3.10.9: bumped from 1500ms to 2500ms. Tobe's
      // v3.10.8 report: "the cue sound interrupts the
      // companion speech at its end." MediaPlayer's
      // OnCompletionListener fires when the player's
      // internal buffer is drained, but the audio HAL
      // still has 100-300ms of buffered audio on the
      // speakers. The 1500ms gap was sometimes not
      // enough to mask this — the cue would start while
      // the last syllable was still audible. 2500ms
      // gives a comfortable buffer that should always
      // clear the speaker before the cue plays.
      //
      // v3.10.9 (later): bumped 2500 → 4000ms. Tobe
      // reported "i think you need more delay on point
      // 2. perhaps double, but it should be smart than
      // a delay? it should run after its done talking
      // if you get my point." The "smart" version would
      // be MediaPlayer.setNextMediaPlayer to chain the
      // cue to the response audio natively — no JS-side
      // coordination needed. That's a larger native
      // refactor (requires the cue asset to be preloaded
      // and a second MediaPlayer instance held alive
      // across the response playback). For now, bump
      // the settle delay further to give the HAL buffer
      // time to drain. 4000ms is a comfortable cap —
      // long enough to mask even the slowest HAL drain
      // (~200-500ms observed on Android 12+), short
      // enough to feel snappy when the user is ready
      // for the next turn.
      // v3.9.8 — idempotency guard. audioPlayerFinished
      // listeners are added with `addListener` (not once)
      // and never cleaned up; combined with the turn-cue
      // sound also calling startPlayer (which emits
      // audioPlayerFinished on completion), a single
      // response can trigger afterPlayback 2-3 times.
      // Without this guard the recording turn starts
      // multiple times, the turn cue plays multiple times,
      // and listeners accumulate across turns. The flag
      // makes afterPlayback a no-op on subsequent calls
      // within the same audio-response window.
      let afterPlaybackFired = false;
      const afterPlayback = async () => {
        if (afterPlaybackFired) return;
        afterPlaybackFired = true;
        // Wait for the response to settle before starting
        // the next recording turn. This prevents the
        // multi-turn loop from treating the post-response
        // silence as "user done talking".
        await new Promise((resolve) => setTimeout(resolve, RESPONSE_SETTLE_DELAY_MS));

        // v3.9.8 — play the user's chosen turn-cue sound
        // BEFORE starting the recording turn. This gives
        // the user a clear audio signal that the mic is
        // about to be live and it's their turn to speak.
        //
        // v3.10.13: lifted the cue-play + wait-for-completion
        // logic out of afterPlayback into a shared
        // playTurnCueAndWait() callback (defined near
        // playExitReply). Now also called from the
        // no-response retry path so the user gets the
        // cue on EVERY transition to a new recording
        // turn, not just after successful responses.
        await playTurnCueAndWait();

        if (voiceMode) {
          // Multi-turn loop: immediately start another
          // recording window. The same handleWakeWordInner
          // body runs (VAD + recorder + silence + send),
          // but `wakeWordBusyRef.current` is already false
          // since the previous turn cleared it on send.
          // Recording continues until silence/exit-phrase
          // triggers the next send.
          // v3.2.24 — reset voiceStatus to 'listening' so the
          // overlay shows YOUR TURN (green). Previously the
          // 'responding' status from onChat would persist
          // through the next turn, showing "Responding..." when
          // the user had already moved on. Fix: explicitly
          // clear to 'listening' here, before kicking off the
          // next recording turn.
          setVoiceStatus('listening');
          addVoiceLog('🎤 Listening for next turn...');
          addLogEntry('🔁 Voice Mode: starting next recording turn', 'info');
          try {
            await startRecordingTurnRef.current?.();
          } catch (e: any) {
            addLogEntry(`Voice Mode next-turn start failed: ${e?.message}`, 'error');
          }
          return;
        }
        // Wake Mode path (unchanged): restart the wake listener.
        wakeWordBusyRef.current = false;
        setVoiceStatus('listening');
        addVoiceLog('Wake listening...');
        try {
          // v3.1.67: per-companion matcher on listener
          // restart (after the response audio finishes).
          const allKeysRestart = await AsyncStorage.getAllKeys();
          const sampleKeysRestart = allKeysRestart.filter(k => k.startsWith('cyberclaw-wake-samples-'));
          const companionsTrainingRestart = [];
          for (const key of sampleKeysRestart) {
            try {
              const raw = await AsyncStorage.getItem(key);
              if (!raw) continue;
              const parsed = JSON.parse(raw);
              if (parsed?.features?.length) {
                const cid = key.replace('cyberclaw-wake-samples-', '');
                companionsTrainingRestart.push({ companionId: cid, features: parsed.features });
              }
            } catch (_) {}
          }
          if (companionsTrainingRestart.length > 0 && !sampleListenerCleanupRef.current) {
            sampleListenerCleanupRef.current = startSampleMatchListener(
              companionsTrainingRestart, handleWakeWordInner,
              (m) => addLogEntry(m, 'debug'),
            );
            addLogEntry('🔄 Wake Mode: sample listener restarted', 'debug');
          }
        } catch (_) {}
      };
      // Fallback: restart after estimated duration
      const wordCount = (msg.text || '').split(/\s+/).length;
      const fallbackMs = Math.max(6000, Math.ceil((wordCount / 130) * 60 * 1000) + 3000);
      setTimeout(afterPlayback, fallbackMs);
      // Also listen for audioPlayerFinished. v3.9.8:
      // with the turn-cue sound also calling startPlayer
      // (which emits audioPlayerFinished on completion),
      // this listener fires once for the response audio
      // and once for the cue sound. The afterPlaybackFired
      // guard inside afterPlayback makes the second call
      // a no-op so only one recording window starts per
      // audio-response. Proper listener cleanup (capture
      // + remove on effect teardown) is left as a
      // follow-up — the symptom (multiple recording
      // starts per turn) is fixed by the guard.
      wakeWordEmitter?.addListener('audioPlayerFinished', afterPlayback);
    };
    syncClient.on('chat', onChat);
    syncClient.on('audio_response', onAudioResponse);
    // v3.10.14: listen for the desktop's
    // voice_pipeline_stalled event. Emitted by the
    // desktop's renderer-ack watchdog (cyberclaw
    // v3.2.3) when the desktop's renderer doesn't ack
    // the mobile-voice IPC within 8s. Surface a hint
    // earlier than the 30s transcribing timeout so the
    // user knows the desktop pipeline is hung, not
    // just that the response is taking a while.
    const onPipelineStalled = (msg: any) => {
      addLogEntry(
        `⚠️ Desktop pipeline stalled: ${msg?.hint || 'unknown reason'}`,
        'warn',
      );
      addVoiceLog('⚠️ Desktop renderer hung — waiting for retry...');
      // Don't change status here — the desktop may
      // recover and send the response any moment.
      // The hint is purely informational; the
      // transcribing timeout (30s) is the actual
      // failure boundary.
    };
    syncClient.on('voice_pipeline_stalled', onPipelineStalled);
    return () => {
      syncClient.off?.('chat', onChat);
      syncClient.off?.('audio_response', onAudioResponse);
      syncClient.off?.('voice_pipeline_stalled', onPipelineStalled);
    };
  }, [handleWakeWordInner, voiceMode]);

  // Handle back button: exit Wake Mode
  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      exitRef.current();
      return true;
    });
    return () => handler.remove();
  }, []);

  // v3.5.0 — listen for the ML exit-phrase detection. The
  // native OWW detector now runs a second classifier
  // (exitInterpreter) in parallel with the wake classifier
  // and emits 'owwExitDetected' when the active exit
  // phrase is heard. We mirror the text-fallback exit
  // behavior: play the exit reply, then close.
  //
  // The listener stays mounted for the lifetime of the
  // screen (not gated on voiceMode) because a custom-trained
  // exit model is also useful in plain wake mode if the
  // user wants to dismiss the wake mode without saying the
  // wake phrase first. The behavior matches the existing
  // pollForExitPhrase path (text fallback).
  //
  // The exitFiredRef guards against double-triggering:
  // both the ML detector AND the STT-text fallback can
  // fire on the same utterance (exit is 6+ frames above
  // threshold = "thanks" = 6+ frames of similar score;
  // the transcription of "thanks" hits right around the
  // same time). We want the FIRST one to win.
  const exitFiredRef = useRef<boolean>(false);
  useEffect(() => {
    if (!wakeWordEmitter) return;
    const emitter = getWakeWordEmitter();
    if (!emitter) return;
    const sub = emitter.addListener('owwExitDetected', (e: { score: number }) => {
      if (exitFiredRef.current) return;
      exitFiredRef.current = true;
      addLogEntry(`👋 Exit ML detected (${(e.score * 100).toFixed(0)}%)`, 'info');
      addVoiceLogRef.current?.(`👋 Exit ML (${(e.score * 100).toFixed(0)}%) → closing`);
      if (voiceMode) {
        playExitReplyRef.current?.().catch(() => {});
        setTimeout(() => exitRef.current(), 400);
      } else {
        // Plain wake mode + exit phrase = dismiss the wake
        // mode overlay. Same as a single close-button tap.
        exitRef.current();
      }
    });
    return () => {
      sub?.remove?.();
      // Allow another exit (different session) to fire
      // after this screen unmounts.
      exitFiredRef.current = false;
    };
  }, [voiceMode]);

  // v3.5.0 — also reset the exit guard on voiceMode
  // toggle. When voiceMode flips off (the user exited
  // voice mode via close button / auto-close / back),
  // re-arm so a subsequent voiceMode on can fire a fresh
  // exit. Without this, the first exit-detect within the
  // screen's lifetime would lock out all subsequent ones.
  useEffect(() => {
    exitFiredRef.current = false;
  }, [voiceMode]);

  // v3.6.0 — listen for the ML send-word detection. The
  // native OWW detector runs a third classifier
  // (sendInterpreter) in parallel with wake + exit. When
  // it fires, we stop the recorder immediately and send
  // the current utterance. Unlike exit (which closes
  // voice mode entirely), send just commits one turn
  // — the conversation continues with the assistant's
  // response.
  //
  // This is the explicit end-of-utterance cue Tobe asked
  // for: in noisy environments where silence detection
  // can't reliably distinguish "user paused" from
  // "ambient table talk", saying "send" cleanly commits
  // the turn. Works alongside (not instead of) the
  // silence timer.
  //
  // The stopInFlightRef inside stopAndSendRecording
  // guarantees the send-word match and the silence-timer
  // countdown can't both trigger stop() concurrently.
  const sendFiredRef = useRef<boolean>(false);
  useEffect(() => {
    if (!wakeWordEmitter) return;
    const emitter = getWakeWordEmitter();
    if (!emitter) return;
    const sub = emitter.addListener('owwSendDetected', async (e: { score: number; sendword?: string }) => {
      if (sendFiredRef.current) return;
      sendFiredRef.current = true;
      const label = e.sendword || 'send';
      addLogEntry(`📤 Send ML detected: "${label}" (${(e.score * 100).toFixed(0)}%)`, 'info');
      addVoiceLogRef.current?.(`📤 Send word "${label}" → sending`);
      await stopAndSendRecordingRef.current?.('send');
      // Re-arm so the next turn can fire a fresh send.
      // (stopAndSendRecording is one-shot per turn.)
      setTimeout(() => { sendFiredRef.current = false; }, 0);
    });
    return () => {
      sub?.remove?.();
    };
  }, []);

  // v3.6.0 — listen for the periodic owwVad event. The
  // native OWW listening thread emits RMS energy + zero-
  // crossing rate for each ~200ms chunk. We use these to
  // mark whether the active recording turn has seen any
  // speech-like audio at all. If not (silence the entire
  // turn, or just background noise), stopAndSendRecording
  // drops the recording instead of sending it to STT.
  //
  // Speech thresholds (v3.9.5 — match the native-side
  // SPEECH_RMS_THRESHOLD so the gate fires when the
  // native code recognizes speech, not at a stricter
  // RMS that would never trigger):
  //   RMS > 0.015 → not pure silence (this filters out the
  //                 far-field case where the mic recorded
  //                 nothing). Mirrors the native
  //                 SPEECH_RMS_THRESHOLD in WakeWordModule.kt.
  //   ZCR > 0.02  → not pure DC / clipping (this filters
  //                 out the case where the mic saturated).
  //                 From the native owwVad emission path.
  //   RMS > 0.015 → plausible speech level (the main
  //                 gate — sustained ambient noise like
  //                 HVAC / fan noise sits around
  //                 0.001-0.005 RMS, well below this).
  //
  // Once the flag is set, it sticks for the turn — even
  // if the user goes quiet afterwards, we already know
  // they spoke at some point.
  useEffect(() => {
    if (!wakeWordEmitter) return;
    const emitter = getWakeWordEmitter();
    if (!emitter) return;
    const sub = emitter.addListener('owwVad', (e: { rms: number; zcr: number }) => {
      // First speech in this recording turn — mark the
      // gate as passed. Subsequent RMS samples are
      // ignored here.
      if (!speechDetectedDuringRecordingRef.current && e.rms > 0.015 && e.zcr > 0.02) {
        speechDetectedDuringRecordingRef.current = true;
      }
      // v3.10.9: speech-resume detection during the
      // silence countdown. The silence countdown runs
      // for 5s after a silence period is detected. If
      // the user resumes speaking during that window,
      // we should cancel the countdown and let the user
      // continue. Without this, Tobe reported "cuts me
      // off a few seconds before my last sentence
      // finishes" — the typical pattern is "I went to
      // the store [PAUSE 6s] to get milk": the silence
      // detector fires, countdown starts, then Tobe says
      // "to get milk" 2s into the countdown, but the
      // countdown is still running and sends at the 5s
      // mark, cutting off "to get milk". After this fix,
      // speech during countdown cancels it and waits
      // for the NEXT silence period to re-fire.
      //
      // Important: this guard fires on EVERY owwVad
      // sample (1Hz), so we only need to check if the
      // countdown is currently running. If so, cancel.
      // Don't require speechDetectedDuringRecordingRef
      // to be true (that's a first-time flag, not a
      // continuous signal).
      if (silenceCountdownIntervalRef.current != null && e.rms > 0.015) {
        clearInterval(silenceCountdownIntervalRef.current);
        silenceCountdownIntervalRef.current = null;
        silenceFiredRef.current = false;
        setVoiceStatus('listening');
        addVoiceLog('🎤 Speech resumed, continuing to listen');
        addLogEntry('Wake/Voice Mode: speech resumed during countdown, cancelled', 'debug');
      }
    });
    return () => {
      sub?.remove?.();
    };
  }, []);

  // v3.1.79: auto-close + false-open detection.
  //
  // Tobe: "the recording starts getting long. Perhaps we
  // should set a maximum or a smart feature to detect false
  // opens. The same for voice mode."
  //
  // Three guards in this effect:
  //
  //   1. IDLE_TIMEOUT (60s) — if Wake / Voice Mode is open
  //      and no wake match has fired AND no recording has
  //      started AND no message has been received, auto-
  //      close. This catches the "I walked away after
  //      triggering this by accident" case, and the "I was
  //      asleep" case. A 60s window is long enough that a
  //      real user mid-thought can still talk to the
  //      companion.
  //
  //   2. HARD_CAP (5 min) — absolute max time Wake / Voice
  //      Mode can stay open, regardless of activity. If a
  //      session runs this long something has gone wrong
  //      (stuck state, infinite loop, etc). Close it.
  //
  //   3. FALSE_OPEN tracking — on unmount, tell the
  //      detector how long the mode was open and whether a
  //      real recording happened. Short opens with no
  //      recording count as a false open. After 3 false
  //      opens in 5 minutes, the match threshold is
  //      auto-tightened by 0.05 (capped at 0.85). The
  //      threshold decays back to 0 if 5 minutes pass with
  //      no false opens.
  //
  // Implementation notes:
  //   - The 60s timer is reset on every state change that
  //     indicates the user is actually using the mode
  //     (recording, transcribing, responding). The hard cap
  //     is NOT reset \u2014 it always counts from mount.
  //   - The false-open check runs in the unmount cleanup,
  //     so it fires for any exit path: back button, X
  //     button, idle timeout, hard cap.
  const openStartedAtRef = useRef<number>(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hardCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadRecordingRef = useRef<boolean>(false);

  useEffect(() => {
    openStartedAtRef.current = Date.now();
    hadRecordingRef.current = false;

    // Tell the false-open detector we just opened. Returns
    // the current auto-incremented threshold bump (0 if no
    // recent false opens). We log it but don't apply it
    // here \u2014 the matcher reads the bump from storage on
    // its next init.
    noteWakeModeOpen().then((bump) => {
      if (bump > 0) {
        addLogEntry(`\ud83d\udd0a Auto-tightened match threshold by +${(bump * 100).toFixed(0)}% (recent false opens)`, 'info');
      }
    }).catch(() => {});

    // Hard cap: 5 minutes absolute max. We never reset this.
    hardCapTimerRef.current = setTimeout(() => {
      addLogEntry('\u23f9\ufe0f Wake/Voice Mode: 5 min hard cap reached, closing', 'info');
      addVoiceLog('\u23f9\ufe0f Auto-closing (5 min cap)');
      exitRef.current();
    }, 5 * 60 * 1000);

    // Idle timeout: 60s with no activity. Reset by the
    // effect below on every voiceStatus change that
    // indicates activity.
    const resetIdle = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        addLogEntry('\u23f9\ufe0f Wake/Voice Mode: 60s idle, closing', 'info');
        addVoiceLog('\u23f9\ufe0f Auto-closing (idle)');
        exitRef.current();
      }, 60 * 1000);
    };
    resetIdle();

    return () => {
      // Unmount: stop timers, report false-open status.
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (hardCapTimerRef.current) clearTimeout(hardCapTimerRef.current);
      const openDuration = Date.now() - openStartedAtRef.current;
      const mode: 'wake' | 'voice' = voiceMode ? 'voice' : 'wake';
      noteWakeModeExit(mode, openDuration, hadRecordingRef.current).then((res) => {
        if (res.falseOpenRecorded) {
          addLogEntry(`\u26a0\ufe0f False open recorded (${mode} mode, ${(openDuration / 1000).toFixed(0)}s, no recording)`, 'debug');
        }
        if (res.newThreshold > 0) {
          addLogEntry(`\ud83d\udd0a Match threshold auto-tightened to +${(res.newThreshold * 100).toFixed(0)}% after 3 false opens`, 'info');
        }
      }).catch(() => {});
    };
  }, []);

  // Reset the idle timer whenever the user does something
  // that counts as real activity.
  useEffect(() => {
    if (voiceStatus === 'recording' || voiceStatus === 'transcribing' || voiceStatus === 'silence_countdown') {
      hadRecordingRef.current = true;
      // Re-arm the idle timer with a longer window (2 min)
      // for the response to play back.
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        addLogEntry('\u23f9\ufe0f Wake/Voice Mode: 2 min idle during response, closing', 'info');
        addVoiceLog('\u23f9\ufe0f Auto-closing (idle)');
        exitRef.current();
      }, 2 * 60 * 1000);
    } else if (voiceStatus === 'listening') {
      // Reset to 60s idle window when we go back to listening
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        addLogEntry('\u23f9\ufe0f Wake/Voice Mode: 60s idle (no wake match), closing', 'info');
        addVoiceLog('\u23f9\ufe0f Auto-closing (idle)');
        exitRef.current();
      }, 60 * 1000);
    }
  }, [voiceStatus]);

  // Handle app state changes: if app goes to background while Wake Mode
  // is active, that's fine — when it comes back, Wake Mode is still showing.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
    });
    return () => sub?.remove?.();
  }, []);

  // Cleanup on unmount: stop recorder, stop listener, etc.
  useEffect(() => {
    return () => {
      sampleListenerCleanupRef.current?.();
      sampleListenerCleanupRef.current = null;
      try { getSimpleAudioRecorder().stop(); } catch (_) {}
      try { WakeWordModule?.stopSampleListening?.(); } catch (_) {}
    };
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      <WebView
        key={webViewKey}
        ref={webViewRef}
        // v3.1.50: include ?mode=wake so the arena renders with a
        // solid black background (no forest). Also include the
        // APP_VERSION cache-buster so an APK upgrade forces a
        // fresh arena.html load (Android WebView caches
        // file:///android_asset/ aggressively by URI).
        source={{ uri: `file:///android_asset/arena.html?v=${APP_VERSION}&companion=${companionId}&platform=mobile&mode=wake&onlyActive=true&centered=true` }}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        javaScriptEnabled
        allowFileAccess
        originWhitelist={['*']}
        onLoadEnd={() => {
          // v3.1.64: init the canvas with the full screen
          // dimensions, not the small ARENA_HEIGHT. Without
          // this, the canvas stays at 360x200 (the default
          // fallback) and the CSS-stretched canvas makes the
          // 320px companion look gigantic. Re-initializing to
          // the full WebView size keeps the companion at the
          // intended visual size.
          const { width: SW, height: SH } = require('react-native').Dimensions.get('window');
          webViewRef.current?.injectJavaScript(
            `window.Arena && window.Arena.init(${SW}, ${SH}); true;`,
          );
        }}
      />

      {/* Voice status overlay (top) */}
      <View style={styles.voiceStatusOverlay} pointerEvents="none">
        <Text style={[
          styles.voiceStatusText,
          // v3.2.24: YOUR TURN (green, big) when waiting
          // for the user. Responding (orange) when AI is
          // talking. Recording (red, big) when user is
          // actively talking. The user must instantly see
          // whether to talk or to wait.
          //
          // v3.10.7: added 'retrying' status (yellow).
          // Shows during the gap between "no response,
          // retrying" and the next recording window
          // opening, so the overlay doesn't flash
          // YOUR TURN during the retry (Tobe's report:
          // "if its trying again it should not be your
          // turn"). Maps to voiceStatusRetrying style.
          voiceStatus === 'listening' && voiceMode ? styles.voiceStatusYourTurn :
          voiceStatus === 'recording' ? styles.voiceStatusRecording :
          voiceStatus === 'responding' ? styles.voiceStatusResponding :
          voiceStatus === 'retrying' ? styles.voiceStatusRetrying :
          null,
        ]}>
          {voiceStatus === 'greeting' ? '🔊 Greeting... (say wake word to continue)' :
           voiceStatus === 'listening' ? (voiceMode ? '🎤 YOUR TURN' : '🎧 Listening for wake word...') :
           voiceStatus === 'recording' ? '🔴 Recording...' :
           voiceStatus === 'silence_countdown' ? '⏳ Sending...' :
           voiceStatus === 'transcribing' ? '📝 Transcribing...' :
           voiceStatus === 'responding' ? '💬 Responding...' :
           // v3.10.7: retrying state shown between no-
           // response timeout and the next recording
           // window opening. Yellow + hourglass so it
           // visually reads as "waiting, not yet ready
           // for you to talk".
           voiceStatus === 'retrying' ? '⏳ Retrying...' :
           voiceMode ? '🎤 YOUR TURN' : '🎧 Listening for wake word...'}
        </Text>
      </View>

      {/* Voice log overlay (bottom) — v3.1.89 shows last 5 lines */}
      <View style={styles.voiceLogOverlay} pointerEvents="none">
        <Text style={styles.voiceLogText}>
          {voiceLogs.slice(-5).map((l, i) => `${l}`).join('\n')}
        </Text>
      </View>

      {/* X close button (top right) — v3.2.29 also
          plays the exit reply before closing. Fire-and-
          forget: the close happens immediately, the audio
          plays in the background. */}
      <TouchableOpacity style={styles.closeButton} onPress={() => { playExitReply().catch(() => {}); onExit(); }}>
        <Text style={styles.closeButtonText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  webview: { flex: 1, backgroundColor: '#000' },
  voiceStatusOverlay: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  voiceStatusText: {
    color: '#f7931a',
    fontSize: 16,
    fontWeight: '600',
    textShadowColor: '#000',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  // v3.2.24 — color-coded state styles. The default
  // voiceStatusText is orange (the existing color); these
  // three overrides cover the three most-common states
  // where the user needs to know instantly whether to
  // talk, wait, or watch.
  voiceStatusYourTurn: {
    // Green, big. THIS is the most important visual —
    // the user is waiting too long, not realizing it's
    // their turn.
    color: '#10b981',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 1,
  },
  voiceStatusRecording: {
    // Red, big. When the user is being recorded.
    color: '#ef4444',
    fontSize: 22,
    fontWeight: '700',
  },
  voiceStatusResponding: {
    // Orange/yellow, normal size. AI is talking — just wait.
    color: '#fbbf24',
    fontSize: 16,
    fontWeight: '600',
  },
  voiceStatusRetrying: {
    // v3.10.7: yellow, smaller than YOUR TURN but
    // larger than responding — we want to convey
    // "waiting briefly, not yet ready for input".
    // Distinct from 'responding' (which is amber too)
    // so the user knows it's a transient state, not
    // "AI is currently talking". Tobe's complaint
    // was that "YOUR TURN" during retry invited him
    // to talk, but the next recording window wasn't
    // open yet — he would talk into a dead mic.
    color: '#fbbf24',
    fontSize: 20,
    fontWeight: '700',
    fontStyle: 'italic',
  },
  voiceLogOverlay: {
    position: 'absolute',
    bottom: 40,
    left: 16,
    right: 16,
    padding: 8,
  },
  voiceLogText: {
    color: '#10b981',
    fontFamily: 'monospace',
    fontSize: 12,
    textShadowColor: '#000',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  closeButton: {
    position: 'absolute',
    top: 40,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(247, 147, 26, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    color: '#000',
    fontSize: 22,
    fontWeight: '700',
  },
});
