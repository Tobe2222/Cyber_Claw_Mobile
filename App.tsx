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
import QuestsScreen from './src/screens/QuestsScreen';
import syncClient from './src/services/SyncClient';
import { saveGreetingAudio } from './src/services/GreetingAudioCache';
import { migrateLegacyTurnCueKey } from './src/services/VoiceSettings';

const { WakeWordModule } = NativeModules;

let _wakeWordEmitter: NativeEventEmitter | null = null;
const getWakeWordEmitter = () => {
  if (!_wakeWordEmitter && WakeWordModule) {
    _wakeWordEmitter = new NativeEventEmitter(WakeWordModule);
  }
  return _wakeWordEmitter;
};

export default function App(): React.JSX.Element {
  // v3.1.93: defensive clear of stale wake-pending flags on
  // mount. Tobe reported 2026-06-25 that opening the app
  // normally (launcher tap) sometimes jumped straight into
  // Wake Mode. Root cause: the AsyncStorage flag persisted
  // across an app kill (e.g. force-close during a wake
  // session) and was honoured on the next launch even
  // though there was no actual wake intent. The 30s
  // TTL in checkNativePending catches the most common
  // case but not the rare "force-killed within 30s of
  // wake" case.
  //
  // We DON'T want to wipe a flag that was just set by a
  // real wake intent extra — that's what handleWake
  // does, and it needs the flag to survive into the
  // mount where checkNativePending reads it.
  //
  // Compromise: clear the flag on mount ONLY if the
  // native side didn't just set it. We check the native
  // SharedPreferences flag too — if it's also stale,
  // we clear both. The native flag has a 30s TTL baked
  // in via the wake_pending_at timestamp, which
  // checkNativePending already honours. So a real wake
  // intent will have wake_pending_at within the last 30s
  // and we leave it alone.
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

  // v3.2.18: Wake Mode is gone. Only Home, Settings, and
  // Voice Mode exist. The wake word opens Voice Mode directly.
  //
  // v3.10.0: extended with wake-trainer / wake-manager /
  // exit-trainer as full-screen routes instead of inline
  // expanded panels inside CompanionSettingsScreen. Each
  // trainer / manager has its own context state (companion
  // id, name, optional preset phrase) so the back button
  // pops back to the companion settings automatically.
  // Reasoning: Tobe reported that the inline-expanded
  // trainer + manager scrolled into the same surface as
  // the wake settings page, making it ambiguous which
  // "Back" button would do what.
  const [screen, setScreen] = useState<
    'home' | 'settings' | 'voice-mode' | 'companion' | 'quests' |
    'wake-trainer' | 'wake-manager' | 'exit-trainer'
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
  // v3.4.4: id of the companion whose settings are open
  // when screen === 'companion'. Set by SettingsScreen via
  // onOpenCompanion(id).
  const [companionScreenId, setCompanionScreenId] = useState<string | null>(null);
  // v3.1.83: ref so the AppState=active listener (re-added below)
  // can read the CURRENT screen value, not the value captured at
  // useEffect mount time. Without this, the listener would always
  // see 'home' (the initial state) and fire even when the user is
  // already in wake-mode or settings, which is what caused the
  // ping-pong in v3.1.82.
  const screenRef = useRef<'home' | 'settings' | 'voice-mode'>('home');
  useEffect(() => { screenRef.current = screen; }, [screen]);

  // v3.10.1: one-time AsyncStorage key migration.
  // The WakeModeScreen turn-cue reader was pointing at
  // a typo'd legacy key (`cyberc…-turn-cue`) while
  // SettingsScreen wrote to the canonical key
  // (`cyberclaw-voice-turn-cue`). As a result, no cue
  // ever played even when the user had one selected
  // (Tobe hit this — confirmed the cause: the two
  // keys never matched). The fix aligns WakeModeScreen
  // to the canonical key AND migrates any value from
  // the legacy key on the next app start.
  useEffect(() => {
    migrateLegacyTurnCueKey().catch(() => {});
  }, []);

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
      // v3.9.1: also respect the just-exited guard here. The
      // v3.5.2 fix added the same guard to HomeScreen's
      // handleWakeWord (the owwWakeDetected listener), but this
      // App-level handleWake is invoked by both the legacy Vosk
      // path (wakeWordDetected / wakeWordOpenedApp from
      // CyberClawService → WakeReceiver → MainActivity) AND by
      // checkNativePending (the cold-launch flag fallback). If
      // the Vosk recognizer has a wake-like partial buffered
      // right around voice-mode exit (e.g. the exit phrase
      // starts with "hey"), it can fire wakeWordOpenedApp within
      // ~1s of exit. Without this guard the user sees voice mode
      // re-open immediately after closing it.
      if (isWakeJustExited()) {
        console.log('[App] Wake detected but just exited — ignoring');
        return;
      }
      // v3.1.14: also persist the pending flag so if the activity gets
      // recreated while waking from the lock screen (which can happen
      // — the React tree unmounts when the activity is torn down and
      // remounts when MainActivity is brought to front, losing the
      // setScreen state in flight), the next mount or AppState=active
      // transition will pick it up and switch to WakeModeScreen.
      AsyncStorage.setItem('cyberclaw-wake-pending', '1').catch(() => {});
      // v3.2.18: Wake Mode is gone. The wake word now opens
      // Voice Mode directly. Voice Mode starts a recording
      // turn on mount (WakeModeScreen's voice-mode useEffect,
      // v3.2.17), so the user doesn't need to say the wake
      // word a second time to begin speaking. The two-phase
      // wake (wake → greet → wait for second wake → record)
      // pattern is collapsed into one phase.
      setScreen('voice-mode');
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
      // v3.9.1: also respect the just-exited guard on the
      // cold-launch flag path. If the native side persisted
      // a wake_pending flag right before voice mode closed
      // (the MainActivity checkWakeIntent path sets it before
      // the JS onExit has a chance to clear it; on a slow
      // device the flag may still be present in SharedPrefs
      // when HomeScreen mounts a few hundred ms later), the
      // stale-flag check would still see a fresh timestamp
      // and re-open voice mode. Same root cause as the
      // handleWake guard above.
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

  // v3.1.95: pre-warm the openWakeWord TFLite models at app
  // mount. TFLite interpreter creation takes ~500ms on cold
  // load. Without pre-warming, the first wake event after the
  // app opens races with interpreter init and the first wake
  // phrase is missed. Calling initOww here means by the time
  // the user says the wake word, the interpreter is warm and
  // the first frame of audio gets a real classification.
  useEffect(() => {
    if (!WakeWordModule?.initOww) return;
    WakeWordModule.initOww('hey_jarvis', 0.5).catch((err: any) => {
      console.warn('[OWW] prewarm initOww failed:', err?.message || err);
    });
    // v3.5.0: restore any previously-trained exit-phrase
    // model so the user doesn't have to retrain across
    // every app restart. The native side reads the
    // SharedPreferences binding set by setExitModelFromBase64
    // and re-applies it to the running detector.
    //
    // No-op if no exit model has been trained yet (returns
    // null). Errors are logged but non-fatal — voice mode
    // still works via the existing text-fallback exit
    // matcher if the restore fails.
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
              onOpenVoiceMode={() => setScreen('voice-mode')}
              // v3.7.6: arena Quests button (top-left of the
              // arena WebView, mirrors Voice Mode at top-right)
              // now opens the global Quests page directly.
              // v3.7.5 had it deep-link into a per-companion
              // Quests phase in CompanionSettingsScreen, but
              // Quests are global on the desktop so they should
              // be global on the mobile too.
              onOpenQuests={() => setScreen('quests')}
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
              // v3.10.0: push-callbacks for trainer /
              // manager sub-routes. CompanionSettingsScreen
              // calls these instead of toggling inline
              // expand panels. The back button on each
              // sub-screen pops back to the companion
              // settings page (same as before — no
              // navigation history rewound).
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
          {screen === 'quests' && (
            <QuestsScreen onBack={() => setScreen('home')} />
          )}
          {screen === 'voice-mode' && (
            <WakeModeScreen
              companionId={companionId}
              agents={agents}
              voiceMode
              onExit={async () => {
                // v3.5.1: await the pending-flag clearing
                // BEFORE switching screens. The previous
                // version removed the flag fire-and-forget
                // and immediately called setScreen('home'),
                // which mounted HomeScreen. HomeScreen's
                // checkPending effect ran getItem in parallel
                // with the still-in-flight removeItem, and on
                // the next 2s tick the flag was still '1' —
                // voice mode re-opened itself within ~300ms
                // of the user clicking X.
                //
                // Awaiting both clears is enough on its own,
                // but we ALSO bump a module-level guard in
                // HomeScreen (see checkPending there) as
                // belt-and-suspenders for any future code
                // path that re-reads the flag.
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
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
});
