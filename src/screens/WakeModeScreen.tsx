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
import { extractAudioFeatures, matchAgainstTraining, AudioFeatures } from '../services/AudioSampleMatcher';
import { base64ToInt16Array } from '../services/AudioUtils';

import { addLogEntry } from './HomeScreen';
// v3.1.50: APP_VERSION is used as a WebView cache-buster (forces
// fresh asset load on every APK upgrade) and to detect "wake mode"
// vs "home mode" in the arena via ?mode=wake.
import { version as APP_VERSION } from '../../package.json';

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
  _phrase: string,
  trainingFeatures: AudioFeatures[],
  onDetected: () => void,
  onLog?: (msg: string) => void,
  threshold?: number,
): () => void {
  const matchThreshold = threshold ?? SAMPLE_MATCH_THRESHOLD_FG;
  let stopped = false;
  const sub = wakeWordEmitter?.addListener('sampleAudioChunk', async (e: { wav: string }) => {
    if (stopped) return;
    try {
      const pcm16 = base64ToInt16Array(e.wav);
      if (pcm16.length < 1600) return;
      const features = extractAudioFeatures(pcm16);
      const result = await matchAgainstTraining(features, trainingFeatures, matchThreshold);
      if (result.score > 0.45) onLog?.(`sample match: ${(result.score * 100).toFixed(0)}% (thr: ${(matchThreshold * 100).toFixed(0)}%)`);
      if (result.matched && !stopped) {
        onLog?.(`\u2705 Wake word matched! (${(result.score * 100).toFixed(0)}%)`);
        onDetected();
      }
    } catch (err: any) {
      onLog?.(`sample match error: ${err.message}`);
    }
  });
  WakeWordModule?.startSampleListening?.().catch((e: any) => {
    onLog?.(`startSampleListening failed: ${e?.message}`);
  });
  return () => {
    stopped = true;
    sub?.remove?.();
    WakeWordModule?.stopSampleListening?.().catch(() => {});
  };
}

interface WakeModeScreenProps {
  companionId: string;
  agents: Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null }>;
  onExit: () => void;
}

export default function WakeModeScreen({ companionId, agents, onExit }: WakeModeScreenProps) {
  const webViewRef = useRef<WebView>(null);
  const recorderActiveRef = useRef<boolean>(false);
  const sampleListenerCleanupRef = useRef<(() => void) | null>(null);
  const wakeWordBusyRef = useRef(false);
  const appStateRef = useRef<string>(AppState.currentState);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  const [voiceStatus, setVoiceStatus] = useState<string>('listening');
  const [voiceLogs, setVoiceLogs] = useState<string[]>([]);
  const [webViewKey, setWebViewKey] = useState(0);

  const addVoiceLog = useCallback((text: string) => {
    setVoiceLogs(prev => [...prev, text].slice(-4));
  }, []);

  // Speak via native TTS (works even when AudioRecord is active)
  const speak = useCallback((text: string) => {
    if (WakeWordModule?.speakText) {
      WakeWordModule.speakText(text).catch(() => {
        const escaped = text.replace(/'/g, "\\'").replace(/\n/g, ' ');
        webViewRef.current?.injectJavaScript(
          `if('speechSynthesis'in window){window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance('${escaped}');u.rate=0.95;u.pitch=1.1;window.speechSynthesis.speak(u);}true;`
        );
      });
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
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
        const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
        const phrase = settings.wakeWord || 'hey clawsuu';
        // v3.1.29: same fallback as HomeScreen. If the
        // settings-phrase has no training data, look for any
        // trained phrase in AsyncStorage and use that. This
        // handles the case where the settings got reset to
        // a different phrase after training. The user is
        // told which phrase is actually being used so they
        // can re-train if they want.
        let trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase)).catch(() => null);
        let usedPhrase = phrase;
        if (!trainingJson || !JSON.parse(trainingJson || '{}')?.features?.length) {
          try {
            const allKeys = await AsyncStorage.getAllKeys();
            const sampleKeys = allKeys.filter(k => k.startsWith('cyberclaw-wake-samples-'));
            for (const key of sampleKeys) {
              const raw = await AsyncStorage.getItem(key).catch(() => null);
              if (!raw) continue;
              const parsed = JSON.parse(raw);
              if (parsed?.features?.length) {
                trainingJson = raw;
                const slug = key.replace('cyberclaw-wake-samples-', '');
                usedPhrase = slug.replace(/-/g, ' ').toLowerCase();
                addLogEntry(
                  `⚠️ No samples for "${phrase}" — using samples for "${usedPhrase}" instead. Re-train to fix.`,
                  'warn',
                );
                break;
              }
            }
          } catch {
            // fall through
          }
        }
        const training = trainingJson ? JSON.parse(trainingJson) : null;

        if (cancelled) return;

        if (training?.features?.length) {
          addLogEntry(`🎤 Wake Mode active — listening for: "${usedPhrase}"`, 'info');
          addVoiceLog('Wake listening...');
          addVoiceLog(`Matching: "${usedPhrase}"`);
          addVoiceLog('🔴 Recording...');

          // Speak "ready to chat"
          AsyncStorage.getItem('cyberclaw-ready-phrase').then(p => {
            speak(p || 'Ready to chat');
          }).catch(() => speak('Ready to chat'));

          cleanup = startSampleMatchListener(
            usedPhrase,
            training.features,
            handleWakeWordInner,
            (msg) => addLogEntry(msg, 'debug'),
            // v3.1.49: read the user-configured FG threshold from
            // settings. Defaults to 0.55 if not set.
            (parseFloat(await AsyncStorage.getItem('cyberclaw-wake-fg-threshold') || '0.55')),
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
  const handleWakeWordInner = useCallback(async () => {
    if (wakeWordBusyRef.current) return;
    wakeWordBusyRef.current = true;
    setVoiceStatus('listening');
    addLogEntry('🎤 Wake word matched - recording', 'info');
    addVoiceLog('🎤 Listening...');

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
          const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
          const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
          const phrase = settings.wakeWord || 'hey clawsuu';
          const trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase)).catch(() => null);
          const training = trainingJson ? JSON.parse(trainingJson) : null;
          if (training?.features?.length && !sampleListenerCleanupRef.current) {
            sampleListenerCleanupRef.current = startSampleMatchListener(
              phrase, training.features, handleWakeWordInner,
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
      />

      {/* Voice status overlay (top) */}
      <View style={styles.voiceStatusOverlay} pointerEvents="none">
        <Text style={styles.voiceStatusText}>
          {voiceStatus === 'listening' ? '🎧 Listening for wake word...' :
           voiceStatus === 'recording' ? '🔴 Recording...' :
           voiceStatus === 'silence_countdown' ? '⏳ Sending...' :
           voiceStatus === 'transcribing' ? '📝 Transcribing...' :
           voiceStatus === 'responding' ? '💬 Responding...' :
           '🎧 Listening for wake word...'}
        </Text>
      </View>

      {/* Voice log overlay (bottom) */}
      <View style={styles.voiceLogOverlay} pointerEvents="none">
        <Text style={styles.voiceLogText}>
          {voiceLogs.slice(-3).map((l, i) => `${l}`).join('\n')}
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
