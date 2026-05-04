/**
 * CyberClaw Mobile — Your AI companion on the go
 */

import React, { useState } from 'react';
import { StatusBar, SafeAreaView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import HomeScreen from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ArenaSettingsScreen from './src/screens/ArenaSettingsScreen';

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<'home' | 'settings' | 'arena-settings'>('home');

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.container}>
          <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" translucent={false} />
          {screen === 'home' ? (
            <HomeScreen onOpenSettings={() => setScreen('settings')} onOpenArenaSettings={() => setScreen('arena-settings')} />
          ) : screen === 'settings' ? (
            <SettingsScreen onBack={() => setScreen('home')} />
          ) : (
            <ArenaSettingsScreen onBack={() => setScreen('home')} />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
});
