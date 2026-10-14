/** WakeModeScreen — Fullscreen Wake Mode UI for mobile v3.1.12: This screen replaces the previous approach of flipping a `fullscreen` boolean… */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, BackHandler, StatusBar,
  NativeModules, NativeEventEmitter, AppState, Platform, Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

import syncClient from '../services/SyncClient';
import { getSimpleAudioRecorder } from '../services/SimpleAudioRecorder';
import { getVAD, resetVAD } from '../services/SileroVAD';
import { loadVoiceSettings, DEFAULT_SILENCE_MS } from '../services/VoiceSettings';
import { promptIfMissingTtsEngine } from '../services/TtsPrompt';
import { matchExitPhrase } from '../services/ExitPhraseMatcher';
import { extractAudioFeatures, matchAgainstTraining, matchAgainstAllCompanions, AudioFeatures } from '../services/AudioSampleMatcher';
import { base64ToInt16Array } from '../services/AudioUtils';

import { addLogEntry } from './HomeScreen';
// v3.1.50: APP_VERSION is used as a WebView cache-buster (forces
// fresh asset load on every APK upgrade) and to detect "wake mode"
// vs "home mode" in the arena via ?mode=wake.
import { version as APP_VERSION } from '../../package.json';
// False-open detector + idle timeout.
import { noteWakeModeOpen, noteWakeModeExit } from '../services/WakeTrainingModel';
import { getCachedGreetingPath, ensureGreetingCached } from '../services/GreetingAudioCache';
// Compact speaker-profile bar at the top of the voice-mode screen.
import VoiceEnrollmentBar from '../components/VoiceEnrollmentBar';

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
  // Replaced DTW-based sample matcher with openWakeWord TFLite inference.
  let stopped = false;
  const sub = wakeWordEmitter?.addListener('owwWakeDetected', (e: { score: number; wakeword: string }) => {
    if (stopped) return;
    onLog?.(`✅ Wake word detected: ${e.wakeword} (${(e.score * 100).toFixed(0)}%)`);
    const activeId = companionsTraining[0]?.companionId;
    if (activeId) onDetected(activeId);
  });
  // Init OWW with the active companion's saved wake phrase (if any), falling back to 'hey_jarvis'.
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
  // VoiceMode disables the wake word listener AND starts the VAD + recorder automatically (the voice mode process).
  voiceMode?: boolean;
  // Called when the wake word matches.
  onWakeMatch?: (matchedCompanionId: string) => void;
}

export default function WakeModeScreen({
  companionId, agents, onExit, voiceMode = false, onWakeMatch }: WakeModeScreenProps) {
  const webViewRef = useRef<WebView>(null);
  const recorderActiveRef = useRef<boolean>(false);
  // Ref for the per-turn silence listener unsub.
  const silenceUnsubRef = useRef<(() => void) | null>(null);
  // Ref for the JS-side 3s countdown setInterval id.
  const silenceCountdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks whether the silence listener has fired its initial countdown for the current silence period.
  const silenceFiredRef = useRef<boolean>(false);
  const sampleListenerCleanupRef = useRef<(() => void) | null>(null);
  // TtsInstallPromptedRef REMOVED.
  const wakeWordBusyRef = useRef(false);
  const appStateRef = useRef<string>(AppState.currentState);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  // Ref-mirrored callbacks so the exit listener effect doesn't have to add them as deps (which would cause the listener to tear down + rebuild…
  const playExitReplyRef = useRef<(() => Promise<void>) | null>(null);
  const addVoiceLogRef = useRef<((s: string) => void) | null>(null);
  // Ref-captured reference to the latest startRecordingTurn closure, so the onAudioResponse handler can re-enter the multi-turn loop without…
  const startRecordingTurnRef = useRef<(() => Promise<void>) | null>(null);
  // Ref-captured reference to the latest stopAndSendRecording closure, so the owwSendDetected listener can call it without needing to track…
  const stopAndSendRecordingRef = useRef<((trigger: 'silence' | 'send') => Promise<void>) | null>(null);
  // v3.2.20 — transcribing-state timeout. Set when audio
  // is sent, cleared when a chat/audio_response event arrives
  // (or when voice mode exits).
  const transcribingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Late-response flag.
  const lateResponseReceivedRef = useRef<boolean>(false);
  // Thinking-state timer.
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flag tracking whether the active recording turn has crossed the speech-activity threshold at least once.
  const speechDetectedDuringRecordingRef = useRef<boolean>(false);
  // Sustained-speech counters for the JS side.
  const speechEventsRunRef = useRef<number>(0);
  const lastSpeechEventAtRef = useRef<number>(0);
  // v3.11.47: last time the mic heard voice-level audio (any moment), for end-of-turn.
  const lastVoiceAtRef = useRef<number>(0);
  // v3.11.47: sentence-by-sentence reply playback + tap-to-interrupt.
  const audioChainRef = useRef<Promise<void>>(Promise.resolve());
  const interruptedRef = useRef(false);
  // Counter for consecutive recording turns where no speech was detected.
  const consecutiveEmptyRoundsRef = useRef<number>(0);
  // How many "no speech" rounds before we exit voice mode automatically.
  const MAX_CONSECUTIVE_EMPTY_ROUNDS = 3;
  // Dropped from 4000ms back to 1500ms.
  const RESPONSE_SETTLE_DELAY_MS = 1500;
  // Guards against double-fire when two end-of- turn triggers (silence timer + send word) race for the same recording.
  const stopInFlightRef = useRef<boolean>(false);
  // Track the most recent WS state + the most recent send_error so the 30s transcribing timeout can log a specific reason instead of just "no…
  const lastWsStateRef = useRef<string>('unknown');
  const lastSendErrorRef = useRef<{ type: string; reason: string; at: number } | null>(null);

  // Initialize voiceStatus so the visible status text doesn't flash 'listening' / 'YOUR TURN' before the greeting plays.
  const [voiceStatus, setVoiceStatus] = useState<string>(voiceMode ? 'greeting' : 'listening');
  const [voiceLogs, setVoiceLogs] = useState<string[]>([]);
  // Two-phase wake.
  const [greetingPhase, setGreetingPhase] = useState<'playing' | 'done' | 'skipped'>(
    voiceMode ? 'skipped' : 'playing',
  );
  const [webViewKey, setWebViewKey] = useState(0);

  // Keep last 5 log lines so the WebView fallback decision and the Speaking / Greeting / Matching prelude are all visible at once.
  const addVoiceLog = useCallback((text: string) => {
    setVoiceLogs(prev => {
      const next = prev.length > 0 && prev[prev.length - 1] === text ? prev : [...prev, text];
      return next.slice(-6);
    });
  }, []);
  addVoiceLogRef.current = addVoiceLog;

  // Speak via native TTS (works even when AudioRecord is active).
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
      // Subscribe to the native ttsDone event.
      const emitter = getWakeWordEmitter();
      ttsDoneSub = emitter?.addListener('ttsDone', () => done('native')) ?? null;

      const speakViaWebView = () => {
        // Do NOT call stopSpeaking() here.
        try {
          const escaped = text.replace(/'/g, "\\'").replace(/\n/g, ' ');
          webViewRef.current?.injectJavaScript(
            `if('speechSynthesis'in window){window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance('${escaped}');u.rate=0.95;u.pitch=1.1;window.speechSynthesis.speak(u);}true;`
          );
          addVoiceLog('🔊 (webview fallback)');
          // Estimate bumped from 80ms/char to 100ms/char with a 2000ms minimum.
          const estimateMs = Math.min(6000, Math.max(2000, text.length * 100));
          estimateTimer = setTimeout(() => done('webview-estimate'), estimateMs);
        } catch (_) {
          addVoiceLog('🔊 ❌ both TTS paths failed');
          done('failed');
        }
      };

      // 8-second safety.
      const safetyTimer = setTimeout(() => done('safety'), 8000);

      if (WakeWordModule?.speakText) {
        // Fallback timeout 1500ms → 3500ms.
        fallbackTimer = setTimeout(() => {
          if (!resolved) {
            addVoiceLog('🔊 native TTS slow, falling back');
            speakViaWebView();
          }
        }, 3500);
        WakeWordModule.speakText(text).then(() => {
          // Log the native promise resolution.
          addVoiceLog(`🔊 native enqueued (${Date.now() - t0}ms)`);
        }).catch((err: any) => {
          if (!resolved) {
            // Special-case the "no TTS engine" error so the user sees a clear, actionable message instead of a generic native-failed log.
            const code = err?.code || '';
            if (code === 'TTS_INIT_FAILED') {
              addVoiceLog(`🔊 ❌ TTS init failed (engine probe ran at boot; auto-bind failed): ${err?.message || err}`);
              done('no-tts-engine');
              // Try the WebView fallback anyway.
              try {
                speakViaWebView();
              } catch (_) {}
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

  // Play a cached greeting audio file (WAV synthesized by the desktop's piper TTS).
  const playCachedGreeting = useCallback(async (filePath: string, maxMs?: number): Promise<void> => {
    if (!WakeWordModule?.startPlayer) {
      addVoiceLog('🔊 cached play: startPlayer unavailable');
      return;
    }
    const t0 = Date.now();
    try {
      const { playAudioFile } = require('../services/AudioPlayer');
      await playAudioFile(filePath, maxMs || 10000);
      addVoiceLog(`🔊 done (cached-play, ${Date.now() - t0}ms)`);
    } catch (e: any) {
      addVoiceLog(`🔊 cached play failed: ${e?.message}`);
    }
  }, []);

  // Play the exit reply on voice-mode close.
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
      // v3.10.176: pass companionId so the cache resolves
      // the per-companion voice (otherwise it falls back
      // to 'lessac' and collides across companions).
      const { getCachedExitReplyPath } = require('../services/ExitReplyAudioCache');
      const cached = await getCachedExitReplyPath(
        trimmed, undefined, companionId,
      );
      if (cached) {
        addVoiceLog(`🔊 exit reply (cached): "${trimmed}"`);
        // Fire-and-forget: kick off the play but don't
        // block the close. The audio runs to completion
        // in the background.
        playCachedGreeting(cached).catch(() => {});
        return;
      }
      // No cache — request a synthesis and wait briefly for the WAV.
      const { ensureExitReplyCached } = require('../services/ExitReplyAudioCache');
      const pending = ensureExitReplyCached(
        trimmed, undefined, companionId,
      );
      const timeout = new Promise<null>((r) =>
        setTimeout(() => r(null), 4000),
      );
      const ready = pending.then(async (p) => {
        if (!p) return null;
        // Fire-and-forget — the close happens regardless
        // and the user is fading out of voice mode.
        playCachedGreeting(p).catch(() => {});
        return p;
      }).catch(() => null);
      const finalPath = await Promise.race([ready, timeout]);
      if (!finalPath) {
        addVoiceLog('🔊 exit reply (piper still synthesizing — skipping audio for this close)');
      }
    } catch (e: any) {
      // Dropped the speak() fallback here too.
      addVoiceLog(`� exit reply skipped (cache error: ${e?.message})`);
    }
  }, [speak, companionId]);
  playExitReplyRef.current = playExitReply;

  // Play the user's chosen turn-cue sound and wait for it to finish.
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
      // Pass queueIfPlaying=true so the cue uses MediaPlayer.setNextMediaPlayer.
      WakeWordModule?.startPlayer?.(path, true)?.catch((e: any) => {
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

  // Working cue + speech during LLM processing.
  const cancelWorkingCueRef = useRef<(() => void) | null>(null);
  // Ref-captured latest speak function so the cancel
  // logic can stop the in-flight TTS cleanly.
  const speakRef = useRef<((text: string) => Promise<void>) | null>(null);
  speakRef.current = speak;
  // Reset any in-flight working cue when called.
  const cancelWorkingCue = useCallback(() => {
    if (cancelWorkingCueRef.current) {
      try { cancelWorkingCueRef.current(); } catch (_) {}
      cancelWorkingCueRef.current = null;
    }
  }, []);
  const playWorkingCueAndSpeak = useCallback(async (): Promise<void> => {
    try {
      const VS = require('../services/VoiceSettings');
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const [rawCue, rawSpeech, rawDelay] = await Promise.all([
        AsyncStorage.getItem(VS.WORKING_CUE_KEY),
        AsyncStorage.getItem(VS.WORKING_SPEECH_KEY),
        AsyncStorage.getItem(VS.WORKING_SPEECH_DELAY_KEY),
      ]);
      const cue: string = rawCue || VS.DEFAULT_WORKING_CUE;
      const speech: string = rawSpeech || VS.DEFAULT_WORKING_SPEECH;
      const delayMs = (() => {
        const parsed = rawDelay ? parseInt(rawDelay, 10) : NaN;
        if (!isNaN(parsed)) {
          return Math.max(VS.MIN_WORKING_SPEECH_DELAY_MS, Math.min(VS.MAX_WORKING_SPEECH_DELAY_MS, parsed));
        }
        return VS.DEFAULT_WORKING_DELAY_MS;
      })();
      if ((cue === 'off' || !cue) && (!speech || speech.trim() === '')) {
        // Nothing configured — silently no-op so the
        // 'thinking' status is still shown visually but
        // no audio plays.
        return;
      }
      addLogEntry(`🧠 Working cue=${cue} speech="${speech}" delay=${delayMs}ms`, 'debug');
      let cueCancelled = false;
      const cancelFn = () => { cueCancelled = true; };
      cancelWorkingCueRef.current = cancelFn;
      // Run the cue sound + the speech TTS in parallel.
      // Both have cancel gates so a fast response can
      // stop them mid-flight.
      const cuePromise = (async () => {
        if (cue === 'off' || !cue) return;
        const path = `file:///android_asset/sounds/working-${cue}.wav`;
        let cueFinished = false;
        const cueSub = wakeWordEmitter?.addListener('audioPlayerFinished', () => {
          cueFinished = true;
        });
        WakeWordModule?.startPlayer?.(path, false)?.catch((e: any) => {
          addLogEntry(`Working cue play failed: ${e?.message || e}`, 'warn');
          cueFinished = true;
        });
        await new Promise<void>((resolve) => {
          const start = Date.now();
          const tick = setInterval(() => {
            if (cueCancelled || cueFinished || Date.now() - start > 4000) {
              clearInterval(tick);
              resolve();
              try { cueSub?.remove?.(); } catch (_) {}
            }
          }, 50);
        });
      })();
      const speechPromise = (async () => {
        if (!speech || speech.trim() === '') return;
        // Dropped the 1500ms delay before speaking.
        if (cueCancelled) return;
        // Play the working speech from the piper cache if available, fall back to speak() (Android TTS) on cache miss.
        try {
          const { getCachedWorkingSpeechPath } = require('../services/WorkingSpeechAudioCache');
          const { playAudioFile } = require('../services/AudioPlayer');
          // v3.10.176: pass companionId so the cache
          // resolves the per-companion voice.
          const cached = await getCachedWorkingSpeechPath(
            speech, undefined, companionId,
          );
          if (cached) {
            // Piper audio — same voice as the rest of the session.
            addLogEntry(`🧠 Working speech (piper cache): "${speech}"`, 'debug');
            await playAudioFile(cached);
          } else {
            // Dropped the Android-TTS fallback.
            addLogEntry(`🧠 Working speech (piper cache cold — skipping audio): "${speech}"`, 'debug');
            try {
              const { ensureWorkingSpeechCached } =
                require('../services/WorkingSpeechAudioCache');
              ensureWorkingSpeechCached(
                speech, undefined, companionId,
              ).catch(() => {});
            } catch (_) {}
          }
        } catch (e: any) {
          addLogEntry(`Working speech playback failed: ${e?.message || e}`, 'warn');
        }
      })();
      await Promise.race([
        Promise.all([cuePromise, speechPromise]),
        new Promise<void>((resolve) => {
          const tick = setInterval(() => {
            if (cueCancelled) {
              clearInterval(tick);
              resolve();
            }
          }, 50);
        }),
      ]);
      if (cancelWorkingCueRef.current === cancelFn) {
        cancelWorkingCueRef.current = null;
      }
    } catch (e: any) {
      addLogEntry(`Working cue/speech sequence failed: ${e?.message || e}`, 'warn');
    }
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
      // Also clear the thinking-state timer and cancel any in-flight working cue on unmount.
      if (thinkingTimerRef.current) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      cancelWorkingCue();
    };
  }, []);

  // Lazy TTS availability check, fired the first time the user opens voice mode.
  useEffect(() => {
    promptIfMissingTtsEngine('wake-mode-open').catch(() => {});
  }, []);

  // Apply Wake Mode visual style to the WebView.
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

  // Inject setAgents into the WebView on mount so the companion is drawn.
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

  // Voice-mode mount: skip the wake listener entirely and go straight to recording.
  useEffect(() => {
    if (voiceMode) {
      (async () => {
        addLogEntry('🎤 Voice Mode: starting', 'info');
        // Play the greeting before the first recording turn.
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
          // Pass companionId so the cache resolves the per-companion voice the user picked (otherwise it falls back to 'lessac' and every voice…
          const cachedPath = await getCachedGreetingPath(
            greetingText, undefined, companionId,
          );
          if (cachedPath) {
            addVoiceLog(`🔊 playing cached (${cachedPath.split('/').pop()})`);
            await playCachedGreeting(cachedPath);
          } else {
            addVoiceLog('🔊 no cached audio, requesting piper synthesis');
            // Dropped the speak() fallback (Android TTS — different voice from piper).
            const pending = ensureGreetingCached(
              greetingText, undefined, companionId,
            );
            const timeout = new Promise<void>((r) =>
              setTimeout(() => r(), 4000),
            );
            const ready = pending.then(async (p) => {
              if (!p) return null;
              return playCachedGreeting(p).then(() => p);
            }).catch(() => null);
            await Promise.race([ready, timeout]);
            if (!cachedPath) {
              addVoiceLog('🔊 piper still synthesizing — skipping greeting audio for this turn');
            }
          }
        }

        addLogEntry('🎤 Voice Mode: starting first recording turn', 'info');
        addVoiceLog('🎤 Listening...');
        // Settle + cue before the first recording turn, matching the multi-turn loop's afterPlayback (RESPONSE_SETTLE_DELAY_MS = 4000ms then…
        try {
          if (greetingText) {
            await new Promise((resolve) =>
              setTimeout(resolve, RESPONSE_SETTLE_DELAY_MS),
            );
          }
          await playTurnCueAndWait();
        } catch (_) {
          // settle/cue is best-effort; the recording turn
          // must still start even if they fail.
        }
        setVoiceStatus('listening');
        // Mark busy so onAudioResponse's afterPlayback doesn't think we're idle.
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

  // Start the sample-match wake listener.
  useEffect(() => {
    if (voiceMode) return; // handled above
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        // Per-companion wake training.
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

          // Pre-warm the greeting cache BEFORE the wake event fires.
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

          // Pre-warm the exit-reply too.
          let prewarmExitPhrase = 'Goodbye!';
          try {
            const storedExit = await AsyncStorage.getItem('cyberclaw-exit-reply-phrase');
            if (storedExit !== null && storedExit.trim()) {
              prewarmExitPhrase = storedExit;
            }
          } catch (_) {}
          if (prewarmExitPhrase && prewarmExitPhrase.trim()) {
            const { getCachedExitReplyPath, ensureExitReplyCached } = require('../services/ExitReplyAudioCache');
            try {
              const prewarmExitCached = await getCachedExitReplyPath(prewarmExitPhrase);
              if (prewarmExitCached) {
                addVoiceLog(`🔊 exit reply cached ✓ (${prewarmExitCached.split('/').pop()})`);
              } else {
                addVoiceLog(`🔊 pre-warming exit reply via desktop...`);
                ensureExitReplyCached(prewarmExitPhrase).catch(() => {});
              }
            } catch (_) {}
          }

          // V3.1.80 / v3.1.85: two-phase wake.
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
          // Read the user-configured FG threshold from settings.
          const fgThreshold = parseFloat(
            (await AsyncStorage.getItem('cyberclaw-wake-fg-threshold')) || '0.5',
          );
          // Await the speak() Promise so the listener doesn't start until the greeting actually finishes.
          if (greetingText) {
            // Try cached desktop-synthesized audio first.
            const cachedPath = await getCachedGreetingPath(
              greetingText, undefined, companionId,
            );
            if (cachedPath) {
              addVoiceLog(`🔊 playing cached (${cachedPath.split('/').pop()})`);
              await playCachedGreeting(cachedPath);
            } else {
              addVoiceLog('🔊 no cached audio, requesting piper synthesis');
              // Dropped the speak() fallback (Android TTS) — piper is the single voice (Tobe 2026-08-11).
              ensureGreetingCached(
                greetingText, undefined, companionId,
              ).catch(() => {});
              addVoiceLog('🔊 skipping greeting audio — piper cache cold');
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

    // An 880Hz audio beep was added here as wake-word confirmation.

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

  // Shared stop-and-send path.
  const stopAndSendRecording = useCallback(async (triggerReason: 'silence' | 'send', peekTranscript?: string) => {
    if (stopInFlightRef.current) return;
    stopInFlightRef.current = true;
    // Reset the late-response flag for this new turn.
    lateResponseReceivedRef.current = false;
    const recorder = getSimpleAudioRecorder();
    // Always clear the silence listener + countdown interval at the top of stopAndSendRecording.
    silenceUnsubRef.current?.();
    silenceUnsubRef.current = null;
    if (silenceCountdownIntervalRef.current != null) {
      clearInterval(silenceCountdownIntervalRef.current);
      silenceCountdownIntervalRef.current = null;
    }
    // Reset silence-fired so a future recording turn can fire the countdown again.
    silenceFiredRef.current = false;
    // VoiceStatus reset helper for early-return branches.
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
      // Gibberish gate.
      if (!speechDetectedDuringRecordingRef.current) {
        addLogEntry(`Wake Mode: no speech detected (${triggerReason}), dropping`, 'info');
        addVoiceLog('🔇 No speech detected, skipping…');
        wakeWordBusyRef.current = false;
        stopInFlightRef.current = false;
        resetVoiceStatus();
        consecutiveEmptyRoundsRef.current++;
        const empty = consecutiveEmptyRoundsRef.current;
        addLogEntry(`Wake Mode: consecutive empty rounds = ${empty}`, 'debug');
        if (voiceMode && empty >= MAX_CONSECUTIVE_EMPTY_ROUNDS) {
          addLogEntry(`Wake Mode: ${MAX_CONSECUTIVE_EMPTY_ROUNDS} consecutive empty rounds — exiting voice mode`, 'info');
          addVoiceLog(`🚪 No speech for ${empty} rounds — exiting voice mode`);
          consecutiveEmptyRoundsRef.current = 0;
          // v3.10.160: play the exit phrase before closing
          // + 1500ms delay so the audio actually plays.
          // Same rationale as the exit-phrase listener.
          playExitReplyRef.current?.().catch(() => {});
          setTimeout(() => exitRef.current(), 1500);
          return;
        }
        if (voiceMode) {
          addVoiceLog('🎤 Still listening...');
          startRecordingTurnRef.current?.().catch(() => {});
        }
        return;
      }
      setVoiceStatus('transcribing');
      syncClient.sendAudioInput(base64, 'audio/wav', peekTranscript);
      addLogEntry(`Wake Mode: audio sent for transcription (trigger=${triggerReason})`, 'sent');
      addVoiceLog(triggerReason === 'send' ? '📤 Send word → sent' : '📏 Sent, waiting...');

      // Bump the active-enrollment counter.
      if (voiceMode) {
        try {
          const key = 'cyberclaw-voice-enrollment-active';
          const raw = await AsyncStorage.getItem(key);
          const cur = raw ? parseInt(raw, 10) : 0;
          // Increment by 1 per turn (was 50 in v3.10.35).
          const next = (isNaN(cur) ? 0 : cur) + 1;
          await AsyncStorage.setItem(key, String(next));
        } catch (_) {}
      }

      // Reset the per-turn WS error tracking so the transcribing timeout reads the state for THIS turn, not a stale one from a previous turn.
      lastWsStateRef.current = syncClient.state || 'unknown';
      lastSendErrorRef.current = null;

      // Thinking-state + working-cue trigger.
      if (voiceMode) {
        cancelWorkingCue();
        setVoiceStatus('thinking');
        addVoiceLog('🧠 Thinking...');
        addLogEntry('🧠 Thinking state active immediately on send', 'info');
        // Fire the cue + speech in the background. The
        // function itself manages internal cancellation;
        // we don't need to track its completion here.
        void playWorkingCueAndSpeak();
      }

      // Transcribing timeout.
      transcribingTimeoutRef.current = setTimeout(() => {
        if (wakeWordBusyRef.current) {
          const wsState = lastWsStateRef.current;
          const lastErr = lastSendErrorRef.current;
          let reason = `WS state: ${wsState}, no error events`;
          if (lastErr) {
            reason = `Last send error: type=${lastErr.type} reason=${lastErr.reason} (${Math.round((Date.now() - lastErr.at) / 1000)}s ago)`;
          } else if (wsState === 'disconnected' || wsState === 'lost') {
            reason = `WS state: ${wsState} — audio never reached the desktop`;
          } else if (wsState === 'reconnecting') {
            reason = `WS state: reconnecting — connection dropped mid-conversation`;
          } else if (wsState === 'connected') {
            reason = `WS state: connected, desktop pipeline stalled`;
          }
          addLogEntry(`⏰ Transcribing timeout (30s) — ${reason}`, 'error');
          addLogEntry('⏰ Transcribing timeout (30s) — no response from desktop', 'error');
          addVoiceLog('⏰ No response, retrying...');
          wakeWordBusyRef.current = false;
          // Show a "retrying" status instead of jumping straight to "listening" / YOUR TURN.
          setVoiceStatus('retrying');
          // Cancel any in-flight working cue /speech — the retrying state takes over from thinking now that the desktop is genuinely stalled.
          cancelWorkingCue();
          if (thinkingTimerRef.current) {
            clearTimeout(thinkingTimerRef.current);
            thinkingTimerRef.current = null;
          }
          // Keep resetVoiceStatus behavior for safety (e.g.
          if (voiceMode) {
            // Start a new recording turn so the loop continues.
            if (lateResponseReceivedRef.current) {
              addLogEntry('🔁 Retry path aborted — late response arrived', 'debug');
              // Don't reset the flag here; let it stay true so any further 'transcribing timeout' that may have already queued (e.g.
              return;
            }
            playTurnCueAndWait().then(() => {
              // Re-check after the cue — the cue takes
              // ~1-2s and a late response can arrive
              // during that window. If so, abort.
              if (lateResponseReceivedRef.current) {
                addLogEntry('🔁 Retry path aborted — late response arrived during cue', 'debug');
                return;
              }
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

      // Voice-mode exit-phrase check.
      if (voiceMode) {
        pollForExitPhrase().catch(() => {});
      }
    } catch (e: any) {
      addLogEntry(`Wake Mode: send error (${triggerReason}): ${e?.message}`, 'error');
      wakeWordBusyRef.current = false;
    } finally {
      // The stop-and-send attempt is over.
    }
  }, [voiceMode]);

  // Start a recording turn.
  const startRecordingTurn = useCallback(async () => {
    // Clear any transient 'retrying' state (or any other stuck transient) before opening the new recording window.
    setVoiceStatus('listening');
    const vad = getVAD({ sampleRate: 16000, frameSize: 512, silenceThreshold: 0.02 });
    resetVAD();
    speechDetectedDuringRecordingRef.current = false;
    // Also reset the sustained-speech run counters on every new turn.
    speechEventsRunRef.current = 0;
    lastSpeechEventAtRef.current = 0;
    // Reset silence-fired so the new turn can fire the countdown if it sees silence.
    silenceFiredRef.current = false;
    stopInFlightRef.current = false;

    let silenceMs = DEFAULT_SILENCE_MS;
    try {
      // Load settings for THIS companion (companionId prop).
      const settings = await loadVoiceSettings(companionId);
      silenceMs = settings.silenceMs;
    } catch (_) {}

    try {
      const fs = require('react-native-fs');
      const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-wakemode-${Date.now()}.wav`;
      const recorder = getSimpleAudioRecorder();

      // Clean up any prior turn's silence listener and countdown interval before registering a fresh one.
      silenceUnsubRef.current?.();
      silenceUnsubRef.current = null;
      if (silenceCountdownIntervalRef.current != null) {
        clearInterval(silenceCountdownIntervalRef.current);
        silenceCountdownIntervalRef.current = null;
      }

      // Silence detection.
      // v3.11.47: smart end-of-turn. After a short pause the phone sends what
      // it has so far to the desktop, which transcribes it and judges whether
      // the sentence is finished ("check the miner and…" → keep listening).
      // Finished → send right away, reusing that transcript (no 3 s countdown,
      // no second transcription). Unfinished → keep listening and check again.
      const onSilenceEvent = async () => {
        if (silenceFiredRef.current) return;
        silenceFiredRef.current = true;
        setVoiceStatus('silence_countdown');
        const fsMod = require('react-native-fs');
        const peekOnce = async (): Promise<{ text: string; complete: boolean } | null> => {
          let b64 = '';
          try { b64 = await fsMod.readFile(recPath, 'base64'); } catch (_) { return null; }
          if (!b64 || b64.length < 2000) return null;
          const id = 'peek-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
          return await new Promise((resolve) => {
            const t = setTimeout(() => { syncClient.off?.('voice_peek_result', onRes); resolve(null); }, 5000);
            const onRes = (m: any) => {
              if (!m || m.id !== id) return;
              clearTimeout(t); syncClient.off?.('voice_peek_result', onRes);
              resolve({ text: String(m.text || ''), complete: !!m.complete });
            };
            syncClient.on('voice_peek_result', onRes);
            if (!syncClient.peekVoice(id, b64, 'audio/wav')) { clearTimeout(t); syncClient.off?.('voice_peek_result', onRes); resolve(null); }
          });
        };
        const deadline = Date.now() + Math.max(silenceMs, 1800) + 6000;
        let lastText: string | null = null;
        for (;;) {
          if (stopInFlightRef.current) return;
          const r = await peekOnce();
          if (stopInFlightRef.current) return;
          if (!r || !r.text.trim()) { addVoiceLog('📏 Sending…'); await stopAndSendRecording('silence'); return; }
          const stillTalking = Date.now() - lastVoiceAtRef.current < 500;
          if (!stillTalking && (r.complete || r.text === lastText || Date.now() > deadline)) {
            addVoiceLog('✅ "' + r.text.slice(0, 40) + '"');
            addLogEntry('Wake/Voice Mode: end of turn (' + (r.complete ? 'sentence complete' : 'no new speech') + ')', 'info');
            await stopAndSendRecording('silence', r.text);
            return;
          }
          lastText = r.text;
          setVoiceStatus('listening');
          addVoiceLog('… go on');
          await new Promise<void>(res => setTimeout(() => res(), 1200));
        }
      };
      const onSilenceEventOld = async () => {
        if (silenceFiredRef.current) return;
        silenceFiredRef.current = true;
        addVoiceLog(`⏳ Silence detected (${silenceMs}ms)...`);
        addLogEntry(`Wake/Voice Mode: silence detected after ${silenceMs}ms`, 'info');
        // Surface the smart-silence calibration stats so the user can see what the detector was working with.
        try {
          const stats = recorder.getLastSilenceStats?.();
          if (stats) {
            const mode = stats.useSmartSilence
              ? (stats.smartReady ? 'smart-calibrated' : 'smart-warming')
              : 'absolute';
            addLogEntry(
              `Wake/Voice Mode: silence mode=${mode} noise=${(stats.noiseFloor * 100 | 0) / 100} speech=${(stats.speechFloor * 100 | 0) / 100} threshold=${(stats.silenceThreshold * 100 | 0) / 100}` +
                (stats.maxRecordingHit ? ' (max-recording limit hit)' : ''),
              'info',
            );
          }
        } catch (_) {}
        setVoiceStatus('silence_countdown');
        // Countdown 5s → 3s.
        let count = 3;
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

      // v3.11.47: short pause triggers the end-of-turn check; the user's
      // silence setting is now the upper bound, not the fixed wait.
      await recorder.start(recPath, Math.min(silenceMs, 800));
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

  // Listen for the next userText chat from the desktop and check it against the single configured exit phrase.
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
                // Play the exit reply (fire-and- forget) before closing.
                playExitReply().catch(() => {});
                setTimeout(() => exitRef.current(), 1500);
              }
              resolve(matched);
            }
          } catch (_) {}
        })();
      };
      syncClient.on('chat', onChat);
    });
  }, [voiceMode]);

  // Handle audio response from desktop.
  useEffect(() => {
    const onChat = (msg: any) => {
      if (msg.isUser) return;
      // v3.2.20 — clear the transcribing timeout since we
      // got a response (the desktop pipeline is alive).
      if (transcribingTimeoutRef.current) {
        clearTimeout(transcribingTimeoutRef.current);
        transcribingTimeoutRef.current = null;
      }
      // Clear the thinking-state timer and cancel any in-flight working cue/speech.
      if (thinkingTimerRef.current) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      // Late-response flag.
      lateResponseReceivedRef.current = true;
      cancelWorkingCue();
      // Treat any non-user text as a wake-mode response
      addLogEntry(`💬 Wake Mode response: "${msg.text?.substring(0, 60)}..."`, 'received');
      addVoiceLog(`🔊 "${msg.text?.substring(0, 40)}..."`);
      setVoiceStatus('responding');
    };
    const onAudioResponse = async (msg: any) => {
      // v3.11.47: sentence-by-sentence reply. Non-final parts are queued and
      // played in order; the final part waits for them, then runs the normal
      // end-of-reply logic below.
      if (msg && msg.final === false) {
        if (msg.part === 0) { interruptedRef.current = false; cancelWorkingCue(); setVoiceStatus('responding'); }
        if (transcribingTimeoutRef.current) { clearTimeout(transcribingTimeoutRef.current); transcribingTimeoutRef.current = null; }
        if (thinkingTimerRef.current) { clearTimeout(thinkingTimerRef.current); thinkingTimerRef.current = null; }
        lateResponseReceivedRef.current = true;
        const partB64 = msg.audioBase64;
        audioChainRef.current = audioChainRef.current.then(async () => {
          if (interruptedRef.current || !partB64) return;
          try {
            const fsP = require('react-native-fs');
            const p = fsP.TemporaryDirectoryPath + '/cyberclaw-part-' + Date.now() + '.wav';
            await fsP.writeFile(p, partB64, 'base64');
            await playCachedGreeting(p, Math.ceil(partB64.length * 0.75 / 44100 * 1000) + 2500);
          } catch (_) {}
        });
        return;
      }
      if (msg && msg.final === true) { await audioChainRef.current; if (interruptedRef.current) return; }
      audioChainRef.current = Promise.resolve();
      // Desktop sends synthesized audio. Wake Mode just lets it play.
      addLogEntry('🔊 Wake Mode: audio response from desktop', 'info');
      // v3.2.20 — clear the transcribing timeout since we
      // got a response.
      if (transcribingTimeoutRef.current) {
        clearTimeout(transcribingTimeoutRef.current);
        transcribingTimeoutRef.current = null;
      }
      // Late-response flag (paired with onChat branch above).
      lateResponseReceivedRef.current = true;
      // Also clear the thinking-state timer and cancel working cue/speech.
      if (thinkingTimerRef.current) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      cancelWorkingCue();
      // Gibberish filter.
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
          // Play the exit reply before closing.
          playExitReply().catch(() => {});
          setTimeout(() => exitRef.current?.(), 1500);
          return;
        }
      }
      if (transcribingTimeoutRef.current) {
        clearTimeout(transcribingTimeoutRef.current);
        transcribingTimeoutRef.current = null;
      }
      let playbackDone = false;
      // Actually PLAY the audio.
      if (msg.audioBase64) {
        try {
          const fs = require('react-native-fs');
          const ext = (msg.mimeType && msg.mimeType.includes('wav')) ? 'wav' : 'mp3';
          const tmpPath = `${fs.TemporaryDirectoryPath}/cyberclaw-wakemode-response-${Date.now()}.${ext}`;
          await fs.writeFile(tmpPath, msg.audioBase64, 'base64');
          const fileName = tmpPath.split('/').pop();
          const fileSize = msg.audioBase64.length;
          addLogEntry(`🔊 Wake Mode: response audio written (${fileName}, ${fileSize} base64 chars), playing`, 'info');
          addVoiceLog(`🔊 playing response (${fileSize}b)`);
          // Use the same playCachedGreeting helper as
          // the greeting path so error handling, audio
          // focus, and afterPlayback hooks are identical.
          await playCachedGreeting(tmpPath, Math.ceil(msg.audioBase64.length * 0.75 / 44100 * 1000) + 2500);
          playbackDone = true;
          addLogEntry('🔊 Wake Mode: response audio playback resolved', 'info');
        } catch (e: any) {
          addLogEntry(`🔊 Wake Mode: response audio failed: ${e?.message}`, 'error');
          addVoiceLog(`🔊 ❌ response audio failed: ${e?.message}`);
        }
      } else {
        addLogEntry('🔊 Wake Mode: no audioBase64 in response', 'debug');
      }
      // Track playback start so afterPlayback can wait until the audio actually finishes (not just estimate).
      let afterPlaybackFired = false;
      const afterPlayback = async () => {
        if (afterPlaybackFired) return;
        afterPlaybackFired = true;
        if (interruptedRef.current) { interruptedRef.current = false; return; }
        // Flip the visual to YOUR TURN IMMEDIATELY.
        setVoiceStatus('listening');
        addVoiceLog('🎤 Your turn...');
        addLogEntry('🎤 Voice Mode: audio done, YOUR TURN (settle + cue + recorder)', 'info');
        // Settle: brief mask for the audio HAL buffer drain.
        await new Promise((resolve) => setTimeout(resolve, RESPONSE_SETTLE_DELAY_MS));

        // Play the user's chosen turn-cue sound BEFORE starting the recording turn.
        await playTurnCueAndWait();

        if (voiceMode) {
          // Multi-turn loop: immediately start another recording window.
          addLogEntry('🔁 Voice Mode: starting next recording turn', 'info');
          try {
            await startRecordingTurnRef.current?.();
          } catch (e: any) {
            addLogEntry(`Voice Mode next-turn start failed: ${e?.message}`, 'error');
          }
          return;
        }
        // Wake Mode path: restart the wake listener.
        wakeWordBusyRef.current = false;
        // Status already set at the top of afterPlayback;
        // no need to set it again.
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
      // Also listen for audioPlayerFinished.
      wakeWordEmitter?.addListener('audioPlayerFinished', afterPlayback);
      // v3.11.47: playback already finished above → hand the turn back now
      // instead of waiting for the multi-second fallback timer.
      if (playbackDone) setTimeout(afterPlayback, 150);
    };
    syncClient.on('chat', onChat);
    syncClient.on('audio_response', onAudioResponse);
    // Listen for the desktop's voice_pipeline_stalled event.
    const onPipelineStalled = (msg: any) => {
      addLogEntry(
        `⚠️ Desktop pipeline stalled: ${msg?.hint || 'unknown reason'}`,
        'warn',
      );
      addVoiceLog('⚠️ Desktop renderer hung — waiting for retry...');
      // Don't change status here — the desktop may recover and send the response any moment.
    };
    syncClient.on('voice_pipeline_stalled', onPipelineStalled);
    // Track WS state + send errors so the transcribing timeout can give a specific reason instead of just "no response from desktop".
    const onStateChange = (msg: any) => {
      const newState = msg?.state || 'unknown';
      addLogEntry(`[WS] State change: ${newState}`, 'info');
      // The transcribing-timeout reason lookup
      // reads this most-recent state, so update
      // the ref inline.
      lastWsStateRef.current = newState;
      if (newState === 'disconnected' || newState === 'lost') {
        // Tell the user immediately, not 30s later when the transcribing timeout fires.
        addVoiceLog(`🔌 Lost connection to desktop (${newState})`);
      } else if (newState === 'reconnecting') {
        addVoiceLog('🔄 Reconnecting to desktop…');
      } else if (newState === 'connected') {
        addLogEntry('[WS] Connected to desktop', 'info');
      }
    };
    const onSendError = (msg: any) => {
      const reason = msg?.reason || 'unknown';
      const type = msg?.type || 'unknown';
      addLogEntry(
        `[WS] Send failed: type=${type} reason=${reason}`,
        'error',
      );
      addVoiceLog(`⚠️ Send failed (${reason})`);
      lastSendErrorRef.current = { type, reason, at: Date.now() };
    };
    syncClient.on('state_change', onStateChange);
    syncClient.on('send_error', onSendError);
    return () => {
      syncClient.off?.('chat', onChat);
      syncClient.off?.('audio_response', onAudioResponse);
      syncClient.off?.('voice_pipeline_stalled', onPipelineStalled);
      syncClient.off?.('state_change', onStateChange);
      syncClient.off?.('send_error', onSendError);
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

  // Listen for the ML exit-phrase detection.
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
        // Extended the close delay from 400ms to 1500ms so the exit phrase TTS has time to actually start playing before the screen unmounts.
        playExitReplyRef.current?.().catch(() => {});
        setTimeout(() => exitRef.current(), 1500);
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

  // Also reset the exit guard on voiceMode toggle.
  useEffect(() => {
    exitFiredRef.current = false;
  }, [voiceMode]);

  // Listen for the ML send-word detection.
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

  // Listen for the periodic owwVad event.
  useEffect(() => {
    if (!wakeWordEmitter) return;
    const emitter = getWakeWordEmitter();
    if (!emitter) return;
    const MIN_JS_SPEECH_EVENTS = 3;
    const SPEECH_EVENT_RUN_MAX_GAP_MS = 1500;
    const sub = emitter.addListener('owwVad', (e: { rms: number; zcr: number }) => {
      const now = Date.now();
      if (e.rms > 0.015) lastVoiceAtRef.current = now;
      // Sustained-speech guard mirrors the native counter.
      if (!speechDetectedDuringRecordingRef.current && e.rms > 0.015 && e.zcr > 0.02) {
        if (now - lastSpeechEventAtRef.current > SPEECH_EVENT_RUN_MAX_GAP_MS) {
          speechEventsRunRef.current = 0;
        }
        lastSpeechEventAtRef.current = now;
        speechEventsRunRef.current++;
        if (speechEventsRunRef.current >= MIN_JS_SPEECH_EVENTS) {
          speechDetectedDuringRecordingRef.current = true;
          // Reset the empty-rounds counter — the user is actually speaking now, so the gibberish-gate exit path doesn't apply.
          consecutiveEmptyRoundsRef.current = 0;
        }
      } else if (e.rms < 0.005) {
        speechEventsRunRef.current = 0;
        lastSpeechEventAtRef.current = 0;
      }
      // Speech-resume detection during the silence countdown.
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

  // Auto-close + false-open detection.
  const openStartedAtRef = useRef<number>(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hardCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadRecordingRef = useRef<boolean>(false);

  useEffect(() => {
    openStartedAtRef.current = Date.now();
    hadRecordingRef.current = false;

    // Tell the false-open detector we just opened.
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
      {/* v3.10.24: compact enrollment bar pinned at the
          very top. Sits ABOVE the voice-status overlay
          so it stays visible while the user talks.
          pointerEvents="none" so it never eats taps
          intended for the WebView below.
          v3.10.46: pass mode="active-only" so the bar
          ticks 1-per-voice-mode-turn with a 20-turn
          threshold. Default mode="combined" would show
          the passive OWW count (samplesTotal), which
          accumulates before voice mode started and
          makes the bar look pre-filled when the user
          enters voice mode (Tobe: "100 is not correct,
          it should be 1 for each sample"). Voice mode
          pauses the OWW listener (recorder owns the
          mic) so passive samples don't accumulate
          here — only active voice-mode turns do. */}
      <View style={styles.enrollmentBarCompact} pointerEvents="none">
        <VoiceEnrollmentBar variant="compact" mode="active-only" />
      </View>
      {/* v3.10.32: wrap the WebView in a marginTop
          container so the companion sprite is visually
          pushed below the camera cutout. The WebView
          itself stays full-width; the wrapper provides
          the 80px top margin. */}
      <View style={styles.webviewWrapper}>
        <WebView
          key={webViewKey}
          ref={webViewRef}
          // Include ?mode=wake so the arena renders with a solid black background (no forest).
          source={{ uri: `file:///android_asset/arena.html?v=${APP_VERSION}&companion=${companionId}&platform=mobile&mode=wake&onlyActive=true&centered=true` }}
          style={styles.webview}
          scrollEnabled={false}
          bounces={false}
          javaScriptEnabled
          allowFileAccess
          originWhitelist={['*']}
          onLoadEnd={() => {
            // Size the arena to the WebView's actual content area, not the window.
            const { width: SW, height: SH } = require('react-native').Dimensions.get('window');
            const webviewHeight = SH - 80;  // marginTop
            webViewRef.current?.injectJavaScript(
              `window.Arena && window.Arena.init(${SW}, ${webviewHeight}); true;`,
            );
          }}
        />
      </View>

      {/* Voice status overlay (top)
          v3.10.37: Tobe's design ask — the status cycle
          shows "listening" through the cycle text, and a
          SEPARATE big green "YOUR TURN" overlay appears
          below the cycle when it's actually time for the
          user to talk. Previous v3.10.34 layout had a
          single text element that swapped through several
          states ("Responding...", "Thinking...", "YOUR
          TURN"...) which felt visually noisy. The new
          layout:
            - small cycle-status text at the top
              (🎧 Listening / 🧠 Thinking / 💬 Responding /
               ⏳ Retrying / 🔴 Recording / etc) — drives
              the user's understanding of the cycle
              progression
            - BIG GREEN "🎤 YOUR TURN" overlay rendered
              BELOW the cycle text, visible only when
              voiceMode && status === 'listening'
              (i.e. recorder is hot and the user can speak)
          This way the user sees both: "the system is in
          the LISTENING phase" (small text) AND "this is
          your moment to talk" (big green text). The two
          pieces of info are distinct visual layers rather
          than competing for the same space. */}
      <View style={styles.voiceStatusOverlay} pointerEvents="none">
        {/* Cycle-status text — always small, color-coded
            by current state. */}
        <Text style={[
          styles.voiceStatusText,
          voiceStatus === 'recording' ? styles.voiceStatusCycleRecording :
          voiceStatus === 'responding' ? styles.voiceStatusCycleResponding :
          voiceStatus === 'thinking' ? styles.voiceStatusCycleThinking :
          voiceStatus === 'retrying' ? styles.voiceStatusCycleRetrying :
          voiceStatus === 'silence_countdown' ? styles.voiceStatusCycleCountdown :
          voiceStatus === 'transcribing' ? styles.voiceStatusCycleTranscribing :
          voiceStatus === 'greeting' ? styles.voiceStatusCycleGreeting :
          styles.voiceStatusCycleListening,
        ]}>
          {voiceStatus === 'greeting' ? '🔊 Greeting...' :
           voiceStatus === 'listening' ? (voiceMode ? '🎧 Listening' : '🎧 Listening for wake word...') :
           voiceStatus === 'recording' ? '🔴 Recording' :
           voiceStatus === 'silence_countdown' ? '⏳ Sending' :
           voiceStatus === 'transcribing' ? '📝 Transcribing' :
           voiceStatus === 'thinking' ? '🧠 Thinking' :
           voiceStatus === 'responding' ? '💬 Responding' :
           voiceStatus === 'retrying' ? '⏳ Retrying' :
           (voiceMode ? '🎧 Listening' : '🎧 Listening for wake word...')}
        </Text>
        {/* Big green "YOUR TURN" sub-overlay — visible
            only when voiceMode && status === 'listening'.
            Distinct visual layer from the cycle text so
            the user's eye reads both: "the cycle is in
            listening phase" + "your moment is now". */}
        {voiceMode && voiceStatus === 'listening' && (
          <Text style={styles.voiceStatusYourTurn}>
            🎤 YOUR TURN
          </Text>
        )}
        {/* v3.11.47: tap-to-interrupt while the companion is talking. */}
        {voiceMode && voiceStatus === 'responding' && (
          <TouchableOpacity
            style={{ marginTop: 14, alignSelf: 'center', paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24, backgroundColor: 'rgba(247,147,26,0.18)', borderWidth: 1, borderColor: '#f7931a' }}
            onPress={() => {
              interruptedRef.current = true;
              audioChainRef.current = Promise.resolve();
              try { WakeWordModule?.stopPlayer?.(); } catch (_) {}
              addVoiceLog('✋ Interrupted — your turn');
              setVoiceStatus('listening');
              startRecordingTurnRef.current?.().catch(() => {});
            }}
          >
            <Text style={{ color: '#f7931a', fontSize: 16, fontWeight: '700' }}>✋ Tap to interrupt</Text>
          </TouchableOpacity>
        )}
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
      <TouchableOpacity style={styles.closeButton} onPress={() => {
        // Same delay as the exit-phrase path above.
        playExitReply().catch(() => {});
        setTimeout(() => onExit(), 1500);
      }}>
        <Text style={styles.closeButtonText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  // WebView wrapper with marginTop 80 so the companion sprite sits below the front camera (hole-punch / notch) on modern phones.
  webviewWrapper: { flex: 1, marginTop: 80 },
  webview: { flex: 1, backgroundColor: '#000' },
  // Pushed down to clear the front camera.
  enrollmentBarCompact: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 80,
    paddingBottom: 4,
    alignItems: 'center',
  },
  voiceStatusOverlay: {
    position: 'absolute',
    // Moved from top: 110 to top: 170 so it sits below the pill at its new top: 80 position.
    top: 170,
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
  // Color-coded state styles.
  voiceStatusYourTurn: {
    // BIG green, separate visual layer from the cycle text.
    color: '#10b981',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 1,
    marginTop: 4,
    textShadowColor: '#000',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  // Cycle text styles.
  voiceStatusCycleListening: {
    color: '#10b981',  // green, identical to YOUR TURN
                        // so they feel like the same state
                        // even though they're two layers
    fontSize: 16,
    fontWeight: '700',
  },
  voiceStatusCycleRecording: {
    color: '#ef4444', fontSize: 16, fontWeight: '700',
  },
  voiceStatusCycleResponding: {
    color: '#fbbf24', fontSize: 16, fontWeight: '600',
  },
  voiceStatusCycleThinking: {
    color: '#a78bfa', fontSize: 16, fontWeight: '700',
  },
  voiceStatusCycleRetrying: {
    color: '#fbbf24', fontSize: 16, fontWeight: '600', fontStyle: 'italic',
  },
  voiceStatusCycleCountdown: {
    color: '#fbbf24', fontSize: 16, fontWeight: '600',
  },
  voiceStatusCycleTranscribing: {
    color: '#fbbf24', fontSize: 16, fontWeight: '600',
  },
  voiceStatusCycleGreeting: {
    color: '#f7931a', fontSize: 16, fontWeight: '600',
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
    // Yellow, smaller than YOUR TURN but larger than responding — we want to convey "waiting briefly, not yet ready for input".
    color: '#fbbf24',
    fontSize: 20,
    fontWeight: '700',
    fontStyle: 'italic',
  },
  voiceStatusThinking: {
    // Cyan/violet, between 'responding' and 'retrying'.
    color: '#a78bfa',  // violet-300
    fontSize: 18,
    fontWeight: '700',
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
