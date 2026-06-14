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
  const [screen, setScreen] = useState<'home' | 'settings' | 'wake-mode'>('home');
  const [companionId, setCompanionId] = useState('boar');

  // v3.1.12: Listen for the wake event at the App level (not inside
  // HomeScreen). When the native bridge fires wakeWordOpenedApp (or
  // wakeWordDetected), switch to the dedicated WakeModeScreen. This
  // bypasses HomeScreen's render conditions entirely — the wake-mode
  // UI is rendered by a screen that ONLY renders wake mode, so it
  // can't be wiped by a state reset.
  useEffect(() => {
    const handleWake = () => {
      // Always switch, regardless of which screen we're on. The X
      // button / back button in WakeModeScreen is the only way out.
      setScreen('wake-mode');
    };

    const emitter = getWakeWordEmitter();
    const wakeSub = emitter?.addListener('wakeWordDetected', handleWake);

    // DeviceEventEmitter path (used by MainActivity's emitWakeOpenedWithRetry)
    const { DeviceEventEmitter } = require('react-native');
    const wakeOpenSub = DeviceEventEmitter.addListener('wakeWordOpenedApp', handleWake);

    // AsyncStorage fallback: if HomeScreen persisted a wake-pending flag
    // (e.g. before our listener was attached), pick it up here.
    const checkPending = () => {
      AsyncStorage.getItem('cyberclaw-wake-pending').then(pending => {
        if (pending === '1') {
          AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {});
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
            />
          )}
          {screen === 'settings' && (
            <SettingsScreen onBack={() => setScreen('home')} />
          )}
          {screen === 'wake-mode' && (
            <WakeModeScreen
              companionId={companionId}
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
