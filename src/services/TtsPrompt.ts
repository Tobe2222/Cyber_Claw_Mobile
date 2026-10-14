/** TtsPrompt — lazy TTS availability check + install prompt. */

import { Alert, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DISMISS_KEY = 'cyberclaw-tts-prompt-dismissed-at';
// Bumped from 7 days to 90 days.
const DISMISS_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

let probeInFlight = false;

export async function promptIfMissingTtsEngine(context: string): Promise<boolean> {
  if (probeInFlight) return false;
  probeInFlight = true;
  try {
    const WakeWordModule = (NativeModules as any).WakeWordModule;
    if (!WakeWordModule?.listInstalledTtsEngines) return false;

    // Check dismissal cooldown FIRST. If the user
    // already said "Later" recently, don't even
    // probe — saves the IPC call + avoids noise.
    let lastDismissed = 0;
    try {
      const raw = await AsyncStorage.getItem(DISMISS_KEY);
      if (raw) lastDismissed = parseInt(raw, 10) || 0;
    } catch (_) {}
    if (lastDismissed && Date.now() - lastDismissed < DISMISS_COOLDOWN_MS) {
      console.log(
        `[TTS prompt] suppressed (context=${context}, dismissed ${Math.round((Date.now() - lastDismissed) / 86400000)}d ago, cooldown 90d)`,
      );
      return false;
    }

    let engines: any[] = [];
    try {
      engines = await WakeWordModule.listInstalledTtsEngines();
    } catch (e: any) {
      console.log(`[TTS prompt] listInstalledTtsEngines failed (context=${context}): ${e?.message || e}`);
      return false;
    }
    if (engines.length > 0) {
      console.log(`[TTS prompt] engines present, no prompt needed (context=${context}): ${engines.map((e: any) => e.label).join(', ')}`);
      return false;
    }

    // No engines installed. Show the prompt.
    console.log(`[TTS prompt] no engines, showing prompt (context=${context})`);
    return new Promise<boolean>((resolve) => {
      const proceedWithInstall = () => {
        WakeWordModule.installTtsData?.().catch(() => {});
        resolve(true);
      };
      const dismissForAWhile = () => {
        AsyncStorage.setItem(DISMISS_KEY, String(Date.now())).catch(() => {});
        resolve(false);
      };
      Alert.alert(
        'No TTS engine',
        'CyberClaw needs a Text-to-Speech engine for spoken voice replies. ' +
        'On stock Android use Google TTS. ' +
        'On GrapheneOS / degoogled ROMs install RHVoice (recommended, more natural) or eSpeak NG from F-Droid. ' +
        'Open the system installer?',
        [
          { text: 'Later', style: 'cancel', onPress: dismissForAWhile },
          { text: 'Install', onPress: proceedWithInstall },
        ],
      );
    });
  } finally {
    probeInFlight = false;
  }
}

/** For tests / forced re-prompt (e.g. */
export async function clearTtsPromptDismissal(): Promise<void> {
  await AsyncStorage.removeItem(DISMISS_KEY);
}
