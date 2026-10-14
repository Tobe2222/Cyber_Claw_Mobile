/** ClassifierTest — shared "test a classifier" helper. */

import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  NativeEventEmitter,
  NativeModules,
} from 'react-native';
import RNFS from 'react-native-fs';

const { WakeWordModule } = NativeModules;

export type ClassifierKind = 'wake' | 'exit' | 'send';

export type ClassifierTestResult = {
  fired: boolean;
  firedScore: number | null;
  peak: number;
  // Extra diagnostic fields.
  avg: number;
  // Highest single-chunk score.
  maxChunk: number;
  // Average RMS energy over the test window.
  avgRms: number;
  // Was the OWW listener actually running during the test?
  owwWasRunning: boolean;
  // Which wake model was loaded when the test ran.
  loadedWakeword: string;
  detectorLoaded: boolean;
  final: number;
  durationMs: number;
};

// Map classifier kind → score field name in
// getLatestScores() result.
const SCORE_FIELD: Record<ClassifierKind, 'wake' | 'exit' | 'send'> = {
  wake: 'wake',
  exit: 'exit',
  send: 'send',
};

// Map classifier kind → OWW event name to listen
// for "fired" detection during the test window.
const EVENT_NAME: Record<ClassifierKind, string> = {
  wake: 'owwWakeDetected',
  exit: 'owwExitDetected',
  send: 'owwSendDetected',
};

const TEST_DURATION_MS = 4000;
const POLL_MS = 80;

export function useClassifierTest(
  kind: ClassifierKind,
  options?: { wakeword?: string }
) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ClassifierTestResult | null>(null);
  const abortRef = useRef<{ cancelled: boolean } | null>(null);

  const abort = useCallback(() => {
    if (abortRef.current) abortRef.current.cancelled = true;
  }, []);

  const start = useCallback(async () => {
    if (!WakeWordModule) return;
    // v3.10.25: a previous test still running gets
    // cancelled before we start a new one. Same as
    // the wake-test behavior pre-refactor.
    if (abortRef.current) abortRef.current.cancelled = true;
    setRunning(true);
    setResult(null);
    const abort = { cancelled: false };
    abortRef.current = abort;

    // Switched classifier test from live OWW listener to recorder + offline scoring.
    const startMs = Date.now();
    let peak = 0;
    let maxChunk = 0;
    let scoreSum = 0;
    let scoreSamples = 0;
    let final = 0;
    let firedScore: number | null = null;
    let fired = false;
    let avgRms = 0;
    let owwWasRunning = false;
    // Track which model the detector was actually using when scoring.
    let loadedWakeword = '';
    let detectorLoaded = false;

    // Use a tmp path inside the cache dir so the file is auto-evicted.
    const tmpPath = `${RNFS?.CacheDirectoryPath || '/data/data/com.cyberclawmobile/cache'}/wake-test-${Date.now()}.wav`;
    try {
      // 4000ms silence timeout = test ends when the user stops talking (or after 4s of silence).
      await WakeWordModule?.startRecorderWithSilence?.(tmpPath, TEST_DURATION_MS, true);
      owwWasRunning = true;
      // Wait for the recorder to finish.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TEST_DURATION_MS + 200);
      });
    } catch (_) {
      owwWasRunning = false;
    }

    let wavPath: string | null = null;
    try {
      wavPath = await WakeWordModule?.stopRecorder?.();
    } catch (_) {
      // best-effort
    }

    if (abort.cancelled) {
      // Make sure the recorder is shut down even on cancel.
      try { await WakeWordModule?.stopRecorder?.(); } catch (_) {}
      return;
    }

    if (!wavPath && tmpPath) {
      // Recorder may not have returned a path on auto-stop; fall back to the tmpPath (the recorder writes to that path even if the promise…
      wavPath = tmpPath;
    }

    if (wavPath && WakeWordModule?.scoreWavFile) {
      try {
        // Re-init the OWW detector with the user's ACTIVE wake phrase before scoring.
        const wakewordToScore = options?.wakeword;
        if (wakewordToScore && WakeWordModule?.initOww) {
          try {
            // Same 0.55 nudge as the production paths so the test scorer matches what the live detector uses.
            await WakeWordModule.initOww(wakewordToScore, 0.55);
          } catch (e: any) {
            // Don't silently swallow.
            try {
              const { addLogEntry } = require('./HomeScreen');
              addLogEntry(
                `⚠️ initOww('${wakewordToScore}', 0.5) failed: ${e?.message || e}. Test will score against the previously-loaded model.`,
                'warn',
              );
            } catch (_) {
              // addLogEntry not available — fine, the
              // diagnostic tip already surfaces this.
            }
          }
        }
        const scored: any = await WakeWordModule.scoreWavFile(wavPath);
        if (scored) {
          peak = Number(scored.peak) || 0;
          avgRms = Number(scored.rms) || 0;
          fired = !!scored.fired;
          firedScore = typeof scored.firedScore === 'number' ? scored.firedScore : null;
          scoreSamples = Number(scored.chunksScored) || 0;
          scoreSum = peak * scoreSamples; // approximate avg for display
          maxChunk = peak;
          final = peak;
          // Surface diagnostic info from the native side.
          (scored as any).__loadedWakeword = scored.loadedWakeword;
          (scored as any).__detectorLoaded = scored.detectorLoaded;
          // Also save it in a local var so we can
          // pick it up below when building the result.
          loadedWakeword = String(scored.loadedWakeword || '');
          detectorLoaded = !!scored.detectorLoaded;
        }
      } catch (_) {
        // scoreWavFile failed (no detector, file
        // unreadable, etc.) — fall through with the
        // values we have. avgRms is 0 in this case.
        owwWasRunning = false;
      }
    } else {
      owwWasRunning = false;
    }

    const avg = scoreSamples > 0 ? scoreSum / scoreSamples : 0;
    setResult({
      fired,
      firedScore,
      peak,
      avg,
      maxChunk,
      avgRms,
      owwWasRunning,
      loadedWakeword,
      detectorLoaded,
      final,
      durationMs: Date.now() - startMs,
    });
    setRunning(false);
  }, [kind, options?.wakeword]);
  // Added options?.wakeword to the deps.

  return { running, result, start, abort };
}

const COPY: Record<ClassifierKind, { label: string; running: string; hint: string; fired: string; notFired: string; tip: string; barColor: string }> = {
  wake: {
    label: '🎤 Test wake',
    running: '🎤 Listening\u2026',
    hint: 'Tap, then say the wake phrase. Peak score shown after 4s.',
    fired: 'Wake fired',
    notFired: 'No fire during test',
    tip: 'Tip: aim for Wake peak \u2265 70%.',
    barColor: '#f7931a',
  },
  exit: {
    label: '🚪 Test exit',
    running: '🎤 Listening\u2026',
    hint: 'Tap, then say the trained exit phrase. Peak score shown after 4s.',
    fired: 'Exit fired',
    notFired: 'No fire during test',
    tip: 'Tip: aim for Exit peak \u2265 70%. If low, retrain.',
    barColor: '#f7931a',
  },
  send: {
    label: '✉️ Test send',
    running: '🎤 Listening\u2026',
    hint: 'Tap, then say the send word. Peak score shown after 4s.',
    fired: 'Send fired',
    notFired: 'No fire during test',
    tip: 'Tip: aim for Send peak \u2265 70%. If low, retrain.',
    barColor: '#3b82f6',
  },
};

export function ClassifierTestPanel({
  kind,
  labelOverride,
  hintOverride,
  wakeword,
}: {
  kind: ClassifierKind;
  labelOverride?: string;
  hintOverride?: string;
  // Pass wakeword through to the hook.
  wakeword?: string;
}) {
  const { running, result, start } = useClassifierTest(kind, { wakeword });
  const c = COPY[kind];
  return (
    <View>
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.btn, running ? styles.btnRunning : null, { borderColor: c.barColor }]}
          onPress={start}
          disabled={running}
        >
          <Text style={[styles.btnText, { color: c.barColor }]}>
            {running ? c.running : (labelOverride ?? c.label)}
          </Text>
        </TouchableOpacity>
        <Text style={styles.hint}>{hintOverride ?? c.hint}</Text>
      </View>
      {result && (
        <View style={styles.result}>
          <Text style={styles.resultTitle}>
            {result.fired
              ? `✓ ${c.fired} (${(result.firedScore ?? 0) * 100 | 0}%)`
              : `✗ ${c.notFired}`}
          </Text>
          <View style={styles.scoreRow}>
            <Text style={styles.scoreLabel}>{kind.charAt(0).toUpperCase() + kind.slice(1)} peak</Text>
            <Text style={styles.scoreValue}>
              {(result.peak * 100 | 0)}%
            </Text>
          </View>
          {/* v3.10.30: diagnostic rows. The user hit
              "0% on all 3 tries" before this — no
              way to tell if their mic was dead or
              the model just didn't match. Now we
              show avg score (overall match across
              the test window) and avg RMS (did the
              mic hear anything). The dynamic tip
              below suggests the most likely fix. */}
          <View style={styles.scoreRow}>
            <Text style={styles.scoreLabel}>Average</Text>
            <Text style={styles.scoreValue}>
              {(result.avg * 100 | 0)}%
            </Text>
          </View>
          <View style={styles.scoreRow}>
            <Text style={styles.scoreLabel}>Mic RMS (avg)</Text>
            <Text style={[styles.scoreValue, { color: result.avgRms < 0.005 ? '#ef4444' : '#10b981' }]}>
              {(result.avgRms * 1000 | 0) / 1000}
            </Text>
          </View>
          {/* v3.10.31: explicit "listener running" row.
              When false, the wake test ran against
              silence because the mic was never
              started. Tobe hit this on 4 consecutive
              tries — the diagnostic was correct
              ("mic heard almost nothing") but the
              cause was the wrong one. The listener
              state makes the cause unambiguous. */}
          <View style={styles.scoreRow}>
            <Text style={styles.scoreLabel}>Wake listener</Text>
            <Text style={[styles.scoreValue, { color: result.owwWasRunning ? '#10b981' : '#ef4444' }]}>
              {result.owwWasRunning ? 'running' : 'not running'}
            </Text>
          </View>
          <Text style={styles.tipNote}>
            Over {(result.durationMs / 1000).toFixed(1)}s. {diagnosticTip(result, c.tip)}
          </Text>
        </View>
      )}
    </View>
  );
}

// Dynamic diagnostic tip.
function diagnosticTip(r: ClassifierTestResult, fallback: string): string {
  // Distinguish "mic not running" from "mic dead".
  if (!r.owwWasRunning) {
    return '⚠️ Wake listener wasn\u2019t running — opened the mic for this test, but the detector never produced audio. Try entering voice mode first (it primes the listener), then re-run the test.';
  }
  if (r.avgRms < 0.005) {
    return '⚠️ Mic heard almost nothing. Check mic permission, speak louder, or hold the phone closer.';
  }
  if (r.peak < 0.05) {
    // Distinguish 'model never matched the right phrase' from 'wrong model loaded'.
    const loadedLabel = r.loadedWakeword
      ? ` Loaded model: ${r.loadedWakeword}.`
      : ' Detector not loaded.';
    if (r.loadedWakeword === 'hey_jarvis') {
      return `⚠️ Mic heard you, but the test scored against the bundled 'hey_jarvis' model instead of your trained wake phrase. The active wake binding may be missing — open the Wake sub-page and verify the trained phrase is selected.${loadedLabel}`;
    }
    if (r.loadedWakeword && r.loadedWakeword !== 'hey_jarvis') {
      return `⚠️ Mic heard you, but the loaded model (${r.loadedWakeword}) didn\u2019t match what you said. Try again with the exact phrase, or retrain with cleaner samples.${loadedLabel}`;
    }
    return `⚠️ Mic heard you, but the model never matched. The wake phrase in the trained model may differ from what you said — try again with the exact phrase, or retrain with cleaner samples.${loadedLabel}`;
  }
  if (r.peak < 0.30) {
    return '⚠️ Model saw something but not enough. Try a clearer pronunciation, or retrain with 6 fresh samples in a quiet room.';
  }
  if (r.peak < 0.70) {
    return `Model saw a real signal (peak ${(r.peak * 100 | 0)}%) but below the 70% fire threshold. Try again, or retrain if it keeps happening.`;
  }
  return fallback;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 4,
  },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    backgroundColor: 'rgba(247, 147, 26, 0.05)',
    minWidth: 120,
    alignItems: 'center',
  },
  btnRunning: {
    backgroundColor: 'rgba(251, 191, 36, 0.18)',
    borderColor: '#fbbf24',
  },
  btnText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  hint: {
    color: '#9aa0b4',
    fontSize: 11,
    marginLeft: 10,
    flexShrink: 1,
  },
  result: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#0a0e18',
  },
  resultTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
  },
  scoreRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  scoreLabel: {
    color: '#888',
    fontSize: 12,
  },
  scoreValue: {
    color: '#10b981',
    fontSize: 12,
  },
  tipNote: {
    color: '#888',
    fontSize: 11,
    marginTop: 6,
    fontStyle: 'italic',
  },
});