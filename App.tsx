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

    // v3.1.82 / v3.1.83: native recovery path.
    // MainActivity sets wake_pending=true in
    // SharedPreferences when the wake intent is detected.
    // If the JS context wasn't ready when MainActivity
    // emitted wakeWordOpenedApp (cold start from the
    // lock screen, JS bundle still loading), the emit
    // was dropped. The native flag persists across that
    // race and is consumed by checkNativePending below.
    //
    // v3.1.82 also re-checked on AppState=active as
    // belt-and-suspenders, but that turned into a bug:
    // if the flag was still set when the user manually
    // exited Wake Mode, every subsequent foreground
    // transition would re-fire handleWake and yank them
    // back. v3.1.83 checks the flag ONLY on first mount.
    // The "JS context loaded but event dropped" race is
    // already covered by MainActivity.onResume's
    // emitWakeOpenedWithRetry path.
    const checkNativePending = () => {
      if (!WakeWordModule?.isWakePending) return;
      // v3.1.83 hotfix: only consume the flag if we're not
      // already in wake-mode / settings / voice-mode.
      // Without this guard, an AppState=active transition
      // would re-fire handleWake and yank the user back to
      // Wake Mode after they manually exited (the v3.1.82
      // ping-pong bug). The check uses screenRef because
      // useEffect's [] deps capture 'screen' at mount time.
      if (screenRef.current !== 'home') return;
      WakeWordModule.isWakePending().then((pending: boolean) => {
        if (pending) {
          clearWakePending();
          handleWake();
        }
      }).catch(() => {});
    };
    // v3.1.83: check the native wake-pending flag ONLY on
    // first mount, not on every AppState=active transition.
    //
    // v3.1.82 also re-checked on AppState=active as
    // belt-and-suspenders, but this created a ping-pong:
    // if the flag was still set when the user exited Wake
    // Mode by tapping X, every subsequent foreground
    // transition (notification shade, screen lock+unlock,
    // anything) would re-fire handleWake and yank the user
    // back to Wake Mode.
    //
    // The cold-start recovery case (JS context never came
    // up, MainActivity emitted into the void) is the only
    // case we actually need to recover from, and the first
    // mount handles it. MainActivity.onResume also
    // re-emits via emitWakeOpenedWithRetry, which is the
    // belt-and-suspenders for the JS-context-loaded-but-
    // event-dropped race.
    checkNativePending();
    // v3.1.83 hotfix: re-add the AppState=active listener.
    // v3.1.83 (first cut) removed it because it caused the
    // ping-pong after manual exit, but the listener is
    // also needed for the cold-launch wake path:
    // MainActivity schedules the first
    // emitWakeOpenedWithRetry 250ms after onCreate. If the
    // JS context comes up in that window,
    // checkNativePending() above catches it on mount. If
    // the user re-foregrounds before that retry fires
    // (e.g. notification shade toggle), AppState=active is
    // what consumes the flag. The screenRef guard inside
    // checkNativePending prevents the ping-pong after
    // manual exit: the listener still fires, but no-ops
    // because screenRef.current is 'wake-mode' (or
    // 'settings' / 'voice-mode').
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') checkNativePending();
    });

    return () => {
      wakeSub?.remove?.();
      wakeOpenSub?.remove?.();
      sub?.remove?.();
    };
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
