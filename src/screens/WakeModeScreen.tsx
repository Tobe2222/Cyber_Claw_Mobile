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

const SAMPLE_MATCH_THRESHOLD_FG = 0.55;
const SAMPLE_MATCH_THRESHOLD_BG = 0.65;
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
  const sampleListenerCleanupRef = useRef<(() => void) | null>(null);
  const wakeWordBusyRef = useRef(false);
  const appStateRef = useRef<string>(AppState.currentState);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

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
  const addVoiceLog = useCallback((text: string) => {
    setVoiceLogs(prev => [...prev, text].slice(-5));
  }, []);

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
  // We do this once on mount and once after a short delay (in case
  // the WebView wasn't ready when the first inject fired).
  useEffect(() => {
    const injectAgents = () => {
      try {
        const slim = agents.map((a) => ({
          id: a.id, name: a.name, sprite: a.sprite || null, scale: a.scale || null,
        }));
        webViewRef.current?.injectJavaScript(
          `window.Arena && window.Arena.setAgents(${JSON.stringify(slim)}); true;`,
        );
      } catch (_) {}
    };
    if (agents.length > 0) {
      injectAgents();
      const t = setTimeout(injectAgents, 300);
      return () => clearTimeout(t);
    }
  }, [agents, webViewKey]);

  // Keep screen on while in Wake Mode
  useEffect(() => {
    AppControl?.keepScreenOn?.(true);
    return () => {
      AppControl?.keepScreenOn?.(false);
    };
  }, []);

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
  useEffect(() => {
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
          const fgThreshold = parseFloat(
            (await AsyncStorage.getItem('cyberclaw-wake-fg-threshold')) || '0.55',
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

    const vad = getVAD({ sampleRate: 16000, frameSize: 512, silenceThreshold: 0.02 });
    resetVAD();

    try {
      const fs = require('react-native-fs');
      const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-wakemode-${Date.now()}.m4a`;
      const recorder = getSimpleAudioRecorder();

      // Silence detection: 5s of silence -> 3s countdown -> auto-send
      const unsubSilence = recorder.once('silence', async () => {
        addVoiceLog('⏳ Silence detected...');
        addLogEntry('Wake Mode: silence detected after 5s', 'info');
        setVoiceStatus('silence_countdown');
        let count = 3;
        const tick = setInterval(async () => {
          count--;
          if (count <= 0) {
            clearInterval(tick);
            try {
              const resultPath = await recorder.stop();
              if (!resultPath) {
                addLogEntry('Wake Mode: no recording path', 'error');
                wakeWordBusyRef.current = false;
                return;
              }
              const stats = await fs.stat(resultPath);
              addLogEntry(`Wake Mode: audio file ${stats.size} bytes`, 'info');
              const base64 = await fs.readFile(resultPath, 'base64');
              addLogEntry(`Wake Mode: base64 ${base64.length} chars`, 'info');
              if (base64.length < 100) {
                addLogEntry('Wake Mode: base64 too small, treating as empty', 'error');
                wakeWordBusyRef.current = false;
                return;
              }
              setVoiceStatus('transcribing');
              syncClient.sendAudioInput(base64, 'audio/m4a');
              addLogEntry('Wake Mode: audio sent for transcription', 'sent');
              addVoiceLog('📏 Sent, waiting...');
            } catch (e: any) {
              addLogEntry(`Wake Mode: send error: ${e?.message}`, 'error');
              wakeWordBusyRef.current = false;
            }
          }
        }, 1000);
      });

      await recorder.start(recPath, 5000);
      recorderActiveRef.current = true;
      addLogEntry('Wake Mode: recorder started', 'info');

      // 30s max duration safety
      setTimeout(async () => {
        if (wakeWordBusyRef.current) {
          try { await recorder.stop(); } catch (_) {}
          addLogEntry('Wake Mode: max duration (30s) reached, sending', 'info');
        }
      }, 30000);
    } catch (e: any) {
      addLogEntry(`Wake Mode: recorder failed: ${e?.message}`, 'error');
      wakeWordBusyRef.current = false;
    }
  }, []);

  // Handle audio response from desktop — play it, then restart the wake
  // listener for the next round.
  useEffect(() => {
    const onChat = (msg: any) => {
      if (msg.isUser) return;
      // Treat any non-user text as a wake-mode response
      addLogEntry(`💬 Wake Mode response: "${msg.text?.substring(0, 60)}..."`, 'received');
      addVoiceLog(`🔊 "${msg.text?.substring(0, 40)}..."`);
      setVoiceStatus('responding');
    };
    const onAudioResponse = (msg: any) => {
      // Desktop sends synthesized audio. Wake Mode just lets it play.
      addLogEntry('🔊 Wake Mode: audio response from desktop', 'info');
      // Restart the sample listener after the response finishes
      const restart = async () => {
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
      setTimeout(restart, fallbackMs);
      // Also listen for audioPlayerFinished
      wakeWordEmitter?.addListener('audioPlayerFinished', restart);
    };
    syncClient.on('chat', onChat);
    syncClient.on('audio_response', onAudioResponse);
    return () => {
      syncClient.off?.('chat', onChat);
      syncClient.off?.('audio_response', onAudioResponse);
    };
  }, [handleWakeWordInner]);

  // Handle back button: exit Wake Mode
  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      exitRef.current();
      return true;
    });
    return () => handler.remove();
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
        <Text style={styles.voiceStatusText}>
          {voiceStatus === 'greeting' ? '🔊 Greeting... (say wake word to continue)' :
           voiceStatus === 'listening' ? (voiceMode ? '🎧 Listening...' : '🎧 Listening for wake word...') :
           voiceStatus === 'recording' ? '🔴 Recording...' :
           voiceStatus === 'silence_countdown' ? '⏳ Sending...' :
           voiceStatus === 'transcribing' ? '📝 Transcribing...' :
           voiceStatus === 'responding' ? '💬 Responding...' :
           voiceMode ? '🎧 Listening...' : '🎧 Listening for wake word...'}
        </Text>
      </View>

      {/* Voice log overlay (bottom) — v3.1.89 shows last 5 lines */}
      <View style={styles.voiceLogOverlay} pointerEvents="none">
        <Text style={styles.voiceLogText}>
          {voiceLogs.slice(-5).map((l, i) => `${l}`).join('\n')}
        </Text>
      </View>

      {/* X close button (top right) */}
      <TouchableOpacity style={styles.closeButton} onPress={onExit}>
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
