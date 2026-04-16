/**
 * CyberClaw Mobile — Your AI companion on the go
 * Connects to CyberClaw desktop via WebSocket for companion sync,
 * chat, and always-listening voice features.
 */

import React, { useState } from 'react';
import { StatusBar, SafeAreaView, StyleSheet, TouchableOpacity, Text, View, Platform } from 'react-native';
import HomeScreen from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<'home' | 'settings'>('home');

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      
      {screen === 'home' ? (
        <>
          <HomeScreen />
          {/* Settings gear button */}
          <TouchableOpacity 
            style={styles.settingsBtn}
            onPress={() => setScreen('settings')}
          >
            <Text style={styles.settingsIcon}>⚙️</Text>
          </TouchableOpacity>
        </>
      ) : (
        <SettingsScreen onBack={() => setScreen('home')} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  settingsBtn: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 46 : 56,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  settingsIcon: {
    fontSize: 18,
  },
});
