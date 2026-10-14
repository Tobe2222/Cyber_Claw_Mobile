/**
 * CyberClaw Mobile — Your AI companion on the go
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  SafeAreaView, StyleSheet, NativeModules, NativeEventEmitter, AppState, Alert,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ThemeProvider } from './src/theme/ThemeContext';
import HomeScreen, { markWakeJustExited, isWakeJustExited } from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import WakeModeScreen from './src/screens/WakeModeScreen';
// v3.10.0: trainer / manager sub-routes are now
// full-screen instead of inline-expanded in
// CompanionSettingsScreen.
import OpenWakeWordTrainer from './src/components/OpenWakeWordTrainer';
import WakeSetManagerScreen from './src/components/WakeSetManagerScreen';
import ExitPhraseTrainer from './src/components/ExitPhraseTrainer';
import CompanionSettingsScreen from './src/screens/CompanionSettingsScreen';
// Phone-side companion Personalize screen.
import CompanionEditScreen from './src/screens/CompanionEditScreen';
import QuestsScreen from './src/screens/QuestsScreen';
import SkillsScreen from './src/screens/SkillsScreen';
import syncClient from './src/services/SyncClient';
import { saveGreetingAudio } from './src/services/GreetingAudioCache';
import { saveWorkingSpeechAudio } from './src/services/WorkingSpeechAudioCache';
import {
  migrateLegacyTurnCueKey,
  migrateV3_10_154_dropCloudTts,
} from './src/services/VoiceSettings';

const { WakeWordModule } = NativeModules;

let _wakeWordEmitter: NativeEventEmitter | null = null;
const getWakeWordEmitter = () => {
  if (!_wakeWordEmitter && WakeWordModule) {
    _wakeWordEmitter = new NativeEventEmitter(WakeWordModule);
  }
  return _wakeWordEmitter;
};

export default function App(): React.JSX.Element {
  // Defensive clear of stale wake-pending flags on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await WakeWordModule?.isWakePending?.();
        const pending = !!result?.pending;
        const setAt = result?.setAt ?? 0;
        const ageMs = setAt ? Date.now() - setAt : Infinity;
        const STALE_MS = 30_000;
        if (pending && ageMs > STALE_MS) {
          console.log('[App] Stale native wake-pending flag (age ' + Math.round(ageMs/1000) + 's), clearing');
          await WakeWordModule?.clearWakePending?.().catch(() => {});
          await AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {});
        }
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  // Wake Mode is gone.
  const [screen, setScreen] = useState<
    'home' | 'settings' | 'voice-mode' | 'companion' | 'quests' |
    'wake-trainer' | 'wake-manager' | 'exit-trainer' |
    'companion-edit' | 'companion-edit-looks' | 'companion-edit-behaviour' | 'companion-edit-models' | 'skills'
  >('home');
  // v3.10.0: contexts for the new trainer / manager
  // routes. Set when CompanionSettingsScreen calls a
  // push callback; cleared on pop.
  const [wakeTrainerCtx, setWakeTrainerCtx] = useState<
    { companionId: string; companionName: string; presetPhrase?: string } | null
  >(null);
  const [wakeManagerCtx, setWakeManagerCtx] = useState<
    { companionId: string; companionName: string } | null
  >(null);
  const [exitTrainerCtx, setExitTrainerCtx] = useState<
    { companionId: string; companionName: string; presetPhrase?: string } | null
  >(null);
  // Context for the companion-edit route.
  const [companionEditCtx, setCompanionEditCtx] = useState<
    { companionId: string; companionName: string; emoji?: string | null } | null
  >(null);
  // Context for the Skills route when opened from a companion page.
  const [skillsCtx, setSkillsCtx] = useState<
    { companionId: string; companionName: string; emoji?: string | null } | null
  >(null);
  // v3.4.4: id of the companion whose settings are open
  // when screen === 'companion'. Set by SettingsScreen via
  // onOpenCompanion(id).
  const [companionScreenId, setCompanionScreenId] = useState<string | null>(null);
  // Ref so the AppState=active listener (re-added below) can read the CURRENT screen value, not the value captured at useEffect mount time.
  const screenRef = useRef<typeof screen>('home');
  useEffect(() => { screenRef.current = screen; }, [screen]);

  // One-time AsyncStorage key migration.
  useEffect(() => {
    migrateLegacyTurnCueKey().catch(() => {});
  }, []);

  // One-time cloud-TTS cleanup.
  useEffect(() => {
    migrateV3_10_154_dropCloudTts()
      .then((r) => {
        if (r.clearedKeys || r.normalizedEngines || r.normalizedVoiceIds) {
          console.log(
            `[Migration v3.10.154] cloud-TTS cleanup: cleared ${r.clearedKeys} keys, normalized ${r.normalizedEngines} engines, normalized ${r.normalizedVoiceIds} voice ids`,
          );
        }
      })
      .catch(() => {});
  }, []);

  // One-time migration to seed the mobile's defaultQuestDir setting with the desktop's system-wide default.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-mobile-settings');
        const s = raw ? JSON.parse(raw) : {};
        if (typeof s.defaultQuestDir !== 'string' || !s.defaultQuestDir.trim()) {
          s.defaultQuestDir = '/media/humpsuu/CYBERDRIVE/2B/work/projects';
          await AsyncStorage.setItem('cyberclaw-mobile-settings', JSON.stringify(s));
          console.log('[Migration v3.10.157] seeded defaultQuestDir = /media/humpsuu/CYBERDRIVE/2B/work/projects');
        }
      } catch (_) {}
    })();
  }, []);

  // REMOVED the mount-time TTS prompt.

  // Restore the persisted global speaker profile on cold start.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const WakeWordModule = (NativeModules as any).WakeWordModule;
        WakeWordModule?.loadPersistedSpeakerProfile?.()
          .then((loaded: boolean) => {
            if (loaded) {
              console.log('[App] Speaker profile restored from disk');
            }
          })
          .catch(() => {});
      } catch (_) {}
    }, 1500); // small delay so initOww has a chance to run first
    return () => clearTimeout(t);
  }, []);

  const [companionId, setCompanionId] = useState('boar');
  // Lift agents list to App.tsx so WakeModeScreen can inject setAgents into its (fresh) WebView on mount.
  const [agents, setAgents] = useState<Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null; icon?: string | null; iconFile?: string | null; iconDataUri?: string | null }>>([]);

  // Listen for the wake event at the App level (not inside HomeScreen).
  useEffect(() => {
    const handleWake = () => {
      // Also respect the just-exited guard here.
      if (isWakeJustExited()) {
        console.log('[App] Wake detected but just exited — ignoring');
        return;
      }
      // Also persist the pending flag so if the activity gets recreated while waking from the lock screen (which can happen — the React tree…
      AsyncStorage.setItem('cyberclaw-wake-pending', '1').catch(() => {});
      // Wake Mode is gone.
      setScreen('voice-mode');
    };
    const clearWakePending = () => {
      AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {});
      // Also clear the native SharedPreferences flag set by MainActivity.checkWakeIntent.
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

    // Timestamped wake-pending flag.
    const STALE_FLAG_MS = 30_000;
    const checkNativePending = async () => {
      if (!WakeWordModule?.isWakePending) return;
      if (screenRef.current !== 'home') return;
      // Also respect the just-exited guard on the cold-launch flag path.
      if (isWakeJustExited()) {
        console.log('[App] Native wake-pending flag seen but just exited — ignoring');
        clearWakePending();
        return;
      }
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

  // Pre-warm the Android TextToSpeech engine at app mount.
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

  // Pre-warm the openWakeWord TFLite models at app mount.
  useEffect(() => {
    if (!WakeWordModule?.initOww) return;
    WakeWordModule.initOww('hey_jarvis', 0.5).catch((err: any) => {
      console.warn('[OWW] prewarm initOww failed:', err?.message || err);
    });
    // Restore any previously-trained exit-phrase model so the user doesn't have to retrain across every app restart.
    const wakeMod = WakeWordModule as any;
    if (typeof wakeMod?.loadOwwSavedExitModel === 'function') {
      wakeMod.loadOwwSavedExitModel()
        .then((phrase: string | null) => {
          if (phrase) {
            console.log(`[OWW] Restored exit model for phrase: "${phrase}"`);
          } else {
            console.log('[OWW] No saved exit model — using text-fallback matcher');
          }
        })
        .catch((err: any) => {
          console.warn('[OWW] loadOwwSavedExitModel failed:', err?.message || err);
        });
    }
  }, []);

  // Listen for desktop-synthesized greeting audio and save it to permanent storage.
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

  // Working speech audio cache listener.
  useEffect(() => {
    const onWorkingSpeechAudio = async (msg: any) => {
      const phrase = msg?.text;
      if (!phrase) {
        console.warn('[App] Working speech audio received without text, dropping');
        return;
      }
      const path = await saveWorkingSpeechAudio(phrase, msg.audioBase64);
      if (path) {
        console.log(`[App] Working speech audio cached: ${path.split('/').pop()}`);
      } else {
        console.warn('[App] Failed to save working speech audio');
      }
    };
    syncClient.on('working_speech_audio', onWorkingSpeechAudio);
    return () => { syncClient.off?.('working_speech_audio', onWorkingSpeechAudio); };
  }, []);

  // Pre-warm the working speech cache on app start.
  useEffect(() => {
    (async () => {
      try {
        const { WORKING_SPEECH_KEY, DEFAULT_WORKING_SPEECH } = require('./src/services/VoiceSettings');
        const phrase = (await AsyncStorage.getItem(WORKING_SPEECH_KEY)) || DEFAULT_WORKING_SPEECH;
        if (phrase && phrase.trim() && phrase.trim() !== 'off') {
          const { ensureWorkingSpeechCached } = require('./src/services/WorkingSpeechAudioCache');
          ensureWorkingSpeechCached(phrase.trim());
        }
      } catch (_) {}
    })();
  }, []);

  // Load companion id from storage so WakeModeScreen renders the right sprite
  useEffect(() => {
    AsyncStorage.getItem('cyberclaw-arena-comp').then(v => {
      if (v) setCompanionId(v);
    }).catch(() => {});
  }, []);

  // Hydrate the agents list from local cache on mount so WakeModeScreen has the list immediately when triggered by the wake word.
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
      <ThemeProvider>
        <SafeAreaProvider>
          <SafeAreaView style={styles.container}>
            {screen === 'home' && (
            <HomeScreen
              onOpenSettings={() => setScreen('settings')}
              onOpenVoiceMode={() => setScreen('voice-mode')}
              // Removed the HomeScreen→Skills IPC handler.
              onOpenQuests={() => setScreen('quests')}
              // HomeScreen reports the currently active chat companion back to App.tsx so WakeModeScreen can show the SAME companion the user is looking at.
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
            <SettingsScreen
              onBack={() => setScreen('home')}
              onOpenCompanion={(id) => {
                setCompanionScreenId(id);
                setScreen('companion');
              }}
            />
          )}
          {screen === 'companion' && companionScreenId && (
            <CompanionSettingsScreen
              companionId={companionScreenId}
              onBack={() => {
                setCompanionScreenId(null);
                setScreen('settings');
              }}
              // Push-callbacks for trainer / manager sub-routes.
              onPushWakeTrainer={(ctx) => {
                setWakeTrainerCtx(ctx);
                setScreen('wake-trainer');
              }}
              onPushWakeManager={(ctx) => {
                setWakeManagerCtx(ctx);
                setScreen('wake-manager');
              }}
              onPushExitTrainer={(ctx) => {
                setExitTrainerCtx(ctx);
                setScreen('exit-trainer');
              }}
              // Open the Personalize screen for the companion.
              onOpenCompanionLooks={(ctx) => {
                setCompanionEditCtx(ctx);
                setScreen('companion-edit-looks');
              }}
              onOpenCompanionBehaviour={(ctx) => {
                setCompanionEditCtx(ctx);
                setScreen('companion-edit-behaviour');
              }}
              // Models editor route.
              onOpenCompanionModels={(ctx) => {
                setCompanionEditCtx(ctx);
                setScreen('companion-edit-models');
              }}
              // v3.10.92: legacy single-edit callback.
              // Kept for backward-compat — routes to the
              // behaviour editor (the dominant section).
              onOpenCompanionEdit={(ctx) => {
                setCompanionEditCtx(ctx);
                setScreen('companion-edit-behaviour');
              }}
              // Skills library reachable from the companion settings page.
              onOpenSkills={(ctx) => {
                setSkillsCtx(ctx);
                setScreen('skills');
              }}
            />
          )}
          {screen === 'wake-trainer' && wakeTrainerCtx && (
            <OpenWakeWordTrainer
              companionId={wakeTrainerCtx.companionId}
              companionName={wakeTrainerCtx.companionName}
              presetPhrase={wakeTrainerCtx.presetPhrase}
              onComplete={() => {
                setWakeTrainerCtx(null);
                setScreen('companion');
              }}
              onCancel={() => {
                setWakeTrainerCtx(null);
                setScreen('companion');
              }}
            />
          )}
          {screen === 'wake-manager' && wakeManagerCtx && (
            <WakeSetManagerScreen
              agentId={wakeManagerCtx.companionId}
              agentName={wakeManagerCtx.companionName}
              onBack={() => {
                setWakeManagerCtx(null);
                setScreen('companion');
              }}
            />
          )}
          {screen === 'exit-trainer' && exitTrainerCtx && (
            <ExitPhraseTrainer
              companionId={exitTrainerCtx.companionId}
              companionName={exitTrainerCtx.companionName}
              presetPhrase={exitTrainerCtx.presetPhrase}
              onComplete={() => {
                setExitTrainerCtx(null);
                setScreen('companion');
              }}
              onCancel={() => {
                setExitTrainerCtx(null);
                setScreen('companion');
              }}
            />
          )}
          {/* v3.10.186: split the editor into two dedicated
              screens — one per scope (Looks vs Behaviour).
              The shared context + route pattern means both
              screens pop back to 'companion' via the same
              callback. The mode prop tells CompanionEditScreen
              which section group to render. */}
          {(screen === 'companion-edit' || screen === 'companion-edit-looks' || screen === 'companion-edit-behaviour' || screen === 'companion-edit-models') && companionEditCtx && (
            <CompanionEditScreen
              companionId={companionEditCtx.companionId}
              companionName={companionEditCtx.companionName}
              initialEmoji={companionEditCtx.emoji}
              mode={screen === 'companion-edit-looks' ? 'looks' : screen === 'companion-edit-models' ? 'models' : 'behaviour'}
              onBack={() => {
                setCompanionEditCtx(null);
                setScreen('companion');
              }}
            />
          )}
          {screen === 'quests' && (
            <QuestsScreen onBack={() => setScreen('home')} />
          )}
          {screen === 'skills' && (
            // Skills opened from the companion settings page is bound to that companion via skillsCtx (set by CompanionSettingsScreen.onOpenSkills).
            <SkillsScreen
              onBack={() => {
                if (skillsCtx) {
                  setSkillsCtx(null);
                  setScreen('companion');
                } else {
                  setScreen('home');
                }
              }}
              activeCompanionId={
                skillsCtx?.companionId ||
                companionId ||
                undefined
              }
              activeCompanionName={
                skillsCtx?.companionName ||
                agents.find(a => a.id === companionId)?.name
              }
            />
          )}
          {screen === 'voice-mode' && (
            <WakeModeScreen
              companionId={companionId}
              agents={agents}
              voiceMode
              onExit={async () => {
                // Await the pending-flag clearing BEFORE switching screens.
                markWakeJustExited();
                await Promise.all([
                  AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {}),
                  (WakeWordModule?.clearWakePending?.() ?? Promise.resolve()).catch(() => {}),
                ]);
                setScreen('home');
              }}
            />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // Theme-aware background.
  container: { flex: 1, backgroundColor: '#0a0a0a' },
});
