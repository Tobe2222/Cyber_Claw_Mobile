/**
 * CyberClaw Mobile — Your AI companion on the go
 */

import React, { useState, useEffect } from 'react';
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
  const [companionId, setCompanionId] = useState('boar');
  // v3.1.59: lift agents list to App.tsx so WakeModeScreen can
  // inject setAgents into its (fresh) WebView on mount. Without
  // this, the wake mode WebView has no companions in its array
  // and the companion is missing from wake mode. The home screen's
  // WebView had the agents (setAgents injected on every
  // agents_list broadcast), but the wake mode WebView is a
  // separate instance and never receives setAgents.
  const [agents, setAgents] = useState<Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null }>>([]);

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

    // AsyncStorage fallback: if a wake-pending flag was persisted
    // (because the activity was torn down between the native event
    // firing and our React listener being ready), pick it up here.
    // Run on mount AND on every foregrounding.
    const checkPending = () => {
      AsyncStorage.getItem('cyberclaw-wake-pending').then(pending => {
        if (pending === '1') {
          clearWakePending();
          handleWake();
        }
      }).catch(() => {});
    };
    checkPending();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') checkPending();
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
                setScreen('home');
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
