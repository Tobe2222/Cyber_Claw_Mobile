/**
 * CyberClaw Mobile — Your AI companion on the go
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  StatusBar, SafeAreaView, StyleSheet, NativeModules, NativeEventEmitter, AppState,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';

import HomeScreen from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import WakeModeScreen from './src/screens/WakeModeScreen';
import syncClient from './src/services/SyncClient';
import { saveGreetingAudio } from './src/services/GreetingAudioCache';

const { WakeWordModule } = NativeModules;

let _wakeWordEmitter: NativeEventEmitter | null = null;
const getWakeWordEmitter = () => {
  if (!_wakeWordEmitter && WakeWordModule) {
    _wakeWordEmitter = new NativeEventEmitter(WakeWordModule);
  }
  return _wakeWordEmitter;
};

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<'home' | 'settings' | 'wake-mode' | 'voice-mode'>('home');
  // v3.1.83: ref so the AppState=active listener (re-added below)
  // can read the CURRENT screen value, not the value captured at
  // useEffect mount time. Without this, the listener would always
  // see 'home' (the initial state) and fire even when the user is
  // already in wake-mode or settings, which is what caused the
  // ping-pong in v3.1.82.
  const screenRef = useRef<'home' | 'settings' | 'wake-mode' | 'voice-mode'>('home');
  useEffect(() => { screenRef.current = screen; }, [screen]);
  const [companionId, setCompanionId] = useState('boar');
  // v3.1.59: lift agents list to App.tsx so WakeModeScreen can
  // inject setAgents into its (fresh) WebView on mount. Without
  // this, the wake mode WebView has no companions in its array
  // and the companion is missing from wake mode. The home screen's
  // WebView had the agents (setAgents injected on every
  // agents_list broadcast), but the wake mode WebView is a
  // separate instance and never receives setAgents.
  const [agents, setAgents] = useState<Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null; icon?: string | null; iconFile?: string | null; iconDataUri?: string | null }>>([]);

  // v3.1.12: Listen for the wake event at the App level (not inside
  // HomeScreen). When the native bridge fires wakeWordOpenedApp (or
  // wakeWordDetected), switch to the dedicated WakeModeScreen. This
  // bypasses HomeScreen's render conditions entirely — the wake-mode
  // UI is rendered by a screen that ONLY renders wake mode, so it
  // can't be wiped by a state reset.
  useEffect(() => {
    const handleWake = () => {
      // v3.1.14: also persist the pending flag so if the activity gets
      // recreated while waking from the lock screen (which can happen
      // — the React tree unmounts when the activity is torn down and
      // remounts when MainActivity is brought to front, losing the
      // setScreen state in flight), the next mount or AppState=active
      // transition will pick it up and switch to WakeModeScreen.
      AsyncStorage.setItem('cyberclaw-wake-pending', '1').catch(() => {});
      setScreen('wake-mode');
    };
    const clearWakePending = () => {
      AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {});
      // v3.1.82: also clear the native SharedPreferences
      // flag set by MainActivity.checkWakeIntent. The
      // native side sets wake_pending=true in
      // SharedPreferences when the wake intent extra is
      // present, and clears it when emitWakeOpenedWithRetry
      // succeeds. If we're consuming the wake event here
      // (via the JS listener), the emit also succeeded
      // (or is about to clear on its own). We clear
      // defensively so a future isWakePending() check
      // returns false.
      WakeWordModule?.clearWakePending?.().catch(() => {});
    };

    const emitter = getWakeWordEmitter();
    const wakeSub = emitter?.addListener('wakeWordDetected', () => {
      clearWakePending();
      handleWake();
    });

    // DeviceEventEmitter path (used by MainActivity's emitWakeOpenedWithRetry)
    const { DeviceEventEmitter } = require('react-native');
    const wakeOpenSub = DeviceEventEmitter.addListener('wakeWordOpenedApp', () => {
      clearWakePending();
      handleWake();
    });

    // v3.1.86: timestamped wake-pending flag.
    //
    // v3.1.82 added a SharedPreferences `wake_pending` flag
    // for cold-launch wake recovery (when the JS context
    // never comes up within the 5s emit-retry budget and
    // the user has to kill+reopen). But Tobe reported
    // this caused spurious wake-mode entry on cold launch
    // (a stale flag from a prior session opening wake mode
    // on next launch). He prefers the app to ALWAYS open
    // to home on cold launch.
    //
    // The fix: the flag now has an expiration. MainActivity
    // also stores `wake_pending_at = currentTimeMillis`
    // when setting the flag. The JS bridge returns both the
    // flag value and the timestamp; we consume only if
    // `now - setAt < 30s` (i.e. the flag is fresh from a
    // real wake event in this session). Stale flags are
    // cleared without consuming.
    //
    // The wake-from-cold path still works:
    // - JS context up at wake time: emit immediately,
    //   wakeOpenSub catches it. Flag set but consumed
    //   within milliseconds.
    // - JS context NOT up at wake time: flag set with
    //   timestamp, retry loop runs. If retries succeed,
    //   wakeOpenSub catches it. If retries exhaust and
    //   user reopens within 30s, this listener consumes
    //   the flag and opens wake mode. If user reopens
    //   after 30s, flag is stale, cleared without
    //   consuming.
    const STALE_FLAG_MS = 30_000;
    const checkNativePending = async () => {
      if (!WakeWordModule?.isWakePending) return;
      if (screenRef.current !== 'home') return;
      try {
        const result = await WakeWordModule.isWakePending();
        const pending = !!result?.pending;
        const setAt = result?.setAt ?? 0;
        if (!pending) return;
        const ageMs = Date.now() - setAt;
        if (ageMs > STALE_FLAG_MS) {
          // Stale flag from a prior session. Clear it
          // without consuming — user gets a fresh home
          // screen launch, not a re-entry into wake mode.
          clearWakePending();
          return;
        }
        // Fresh flag from a real wake event. Consume it.
        clearWakePending();
        handleWake();
      } catch (_) {}
    };
    checkNativePending();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') checkNativePending();
    });

    return () => {
      wakeSub?.remove?.();
      wakeOpenSub?.remove?.();
      sub?.remove?.();
    };
  }, []);

  // v3.1.87: pre-warm the Android TextToSpeech engine at app
  // mount. Android's TTS init is async and can take 1-2 seconds
  // on cold start; without pre-warming, the first speak() after
  // a wake event races with the init and the greeting is
  // silently dropped or cut off. Calling prewarmTts here means
  // by the time the user actually wakes the app (a few seconds
  // later), the engine is ready and speakText works on the first
  // call with a reliable ttsDone event.
  //
  // v3.1.90: if prewarm fails, check whether the device has
  // any TTS engine installed at all. If `hasTtsEngine()`
  // returns false, the device is missing a TTS engine (e.g.
  // a stripped Android skin or one without Google TTS) and
  // the wake greeting will be silent until the user installs
  // one. We log a clear console message but don't interrupt
  // the user — the install path is exposed in the Settings
  // screen so they can fix it at their leisure.
  useEffect(() => {
    if (!WakeWordModule?.prewarmTts) return;
    WakeWordModule.prewarmTts().catch((err: any) => {
      console.warn('[TTS] prewarmTts failed:', err?.message || err);
      if (WakeWordModule?.hasTtsEngine) {
        WakeWordModule.hasTtsEngine()
          .then((hasEngine: boolean) => {
            if (!hasEngine) {
              console.warn('[TTS] No TTS engine installed on device. ' +
                'Voice greetings will be silent. ' +
                'Install Google TTS or eSpeak NG from Play Store, ' +
                'then re-open CyberClaw.');
            } else {
              console.warn('[TTS] Engine is installed but init failed. ' +
                'May need voice data download — check Android ' +
                'Settings → Accessibility → Text-to-speech output.');
            }
          })
          .catch(() => {});
      }
    });
  }, []);

  // v3.1.91: listen for desktop-synthesized greeting
  // audio and save it to permanent storage. Mounted at
  // App level so the cache works regardless of which
  // screen is active — Settings → save greeting triggers
  // a synthesis, the audio response arrives a few
  // seconds later, and we cache it whether the user is
  // on Settings, Home, or even Wake Mode.
  //
  // The desktop tags the audio_response with
  // requestId='greeting' (handled in SyncClient) so this
  // listener doesn't compete with the AI-reply playback
  // handler.
  useEffect(() => {
    const onGreetingAudio = async (msg: any) => {
      const phrase = msg?.text;
      if (!phrase) {
        console.warn('[App] Greeting audio received without text, dropping');
        return;
      }
      const path = await saveGreetingAudio(phrase, msg.audioBase64);
      if (path) {
        console.log(`[App] Greeting audio cached: ${path.split('/').pop()}`);
      } else {
        console.warn('[App] Failed to save greeting audio');
      }
    };
    syncClient.on('greeting_audio', onGreetingAudio);
    return () => { syncClient.off?.('greeting_audio', onGreetingAudio); };
  }, []);

  // Load companion id from storage so WakeModeScreen renders the right sprite
  useEffect(() => {
    AsyncStorage.getItem('cyberclaw-arena-comp').then(v => {
      if (v) setCompanionId(v);
    }).catch(() => {});
  }, []);

  // v3.1.67: hydrate the agents list from local cache on
  // mount so WakeModeScreen has the list immediately when
  // triggered by the wake word. Without this, if the user
  // was in Settings (HomeScreen unmounted) when the wake
  // word fired, App.tsx's agents would be empty (only
  // HomeScreen's WebSocket handler propagates them) and
  // WakeModeScreen's WebView would show no companion.
  useEffect(() => {
    AsyncStorage.getItem('cyberclaw-agents-cache').then(raw => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setAgents(parsed);
        }
      } catch (_) {}
    }).catch(() => {});
  }, []);

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.container}>
          <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" translucent={false} />
          {screen === 'home' && (
            <HomeScreen
              onOpenSettings={() => setScreen('settings')}
              onOpenWakeMode={() => setScreen('wake-mode')}
              onOpenVoiceMode={() => setScreen('voice-mode')}
              // v3.1.52: HomeScreen reports the currently active chat
              // companion back to App.tsx so WakeModeScreen can show
              // the SAME companion the user is looking at. Previously
              // App.tsx's companionId was loaded once on mount from
              // AsyncStorage and never updated, so if the user tapped
              // a different companion tab, the wake mode would still
              // show the original saved companion (a stale value).
              onActiveCompanionChange={(id) => {
                if (id && id !== companionId) setCompanionId(id);
              }}
              // v3.1.59: HomeScreen reports the agents list to
              // App.tsx so WakeModeScreen can inject setAgents
              // into its fresh WebView.
              onAgentsChange={(next) => setAgents(next)}
            />
          )}
          {screen === 'settings' && (
            <SettingsScreen onBack={() => setScreen('home')} />
          )}
          {screen === 'wake-mode' && (
            <WakeModeScreen
              companionId={companionId}
              agents={agents}
              onExit={() => {
                AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {});
                // v3.1.83: also clear the native wake-pending
                // flag defensively. The flag is normally
                // cleared by MainActivity.emitWakeOpenedWithRetry
                // on success or by the wake listener path, but
                // if the user exits Wake Mode before either
                // path runs (e.g. tapped X during the greeting
                // phase before the listener came up), the flag
                // would persist. Without this clear, a future
                // checkNativePending (on the next mount after a
                // restart) would re-trigger Wake Mode.
                WakeWordModule?.clearWakePending?.().catch(() => {});
                setScreen('home');
              }}
              // v3.1.67: when the wake word matches, update
              // the active companion so the wake mode shows
              // the right one. Each companion has its own
              // wake word now.
              onWakeMatch={(id) => {
                if (id && id !== companionId) setCompanionId(id);
              }}
            />
          )}
          {screen === 'voice-mode' && (
            <WakeModeScreen
              companionId={companionId}
              agents={agents}
              voiceMode
              onExit={() => setScreen('home')}
            />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
});
