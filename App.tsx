/**
 * CyberClaw Mobile — Your AI companion on the go
 */

import React, { useState } from 'react';
import { StatusBar, SafeAreaView, StyleSheet } from 'react-native';
import HomeScreen from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<'home' | 'settings'>('home');

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" translucent={false} />
      {screen === 'home' ? (
        <HomeScreen onOpenSettings={() => setScreen('settings')} />
      ) : (
        <SettingsScreen onBack={() => setScreen('home')} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
});
