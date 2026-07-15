/**
 * ClassifierTest — shared "test a classifier" helper.
 *
 * v3.10.25: extracted from CompanionSettingsScreen's
 * `handleTestWake` so the same runner can power
 * "Test wake" (Wake sub-page), "Test exit" (Exit
 * sub-page), and "Test send" (Send section in
 * SettingsScreen). The three classifiers share the
 * same melspec+embedding pass on the native side,
 * so the runner takes the classifier name and
 * picks the right score + event to listen for.
 *
 * Two exports:
 *   - `useClassifierTest(classifier)` — hook that
 *     returns `{running, result, start, abort}`.
 *     Result shape is per-classifier (only the
 *     relevant peak + fired/firedScore fields).
 *   - `<ClassifierTestPanel>` — drop-in UI component
 *     that renders the button + result panel. Accepts
 *     a `variant` ('wake' | 'exit' | 'send'), a
 *     `label` override, and a `hint` override. The
 *     default colors and copy match the classifier
 *     (cyan for wake, orange for exit, blue for
 *     send — mirroring the existing trainer colors).
 *
 * Why a hook + a component: the hook lets callers
 * compose their own UI (the existing wake test has
 * a specific layout inside the active-wake panel),
 * while the component gives a one-line drop-in for
 * pages that just want the standard layout.
 */

import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  NativeEventEmitter,
  NativeModules,
} from 'react-native';

const { WakeWordModule } = NativeModules;

export type ClassifierKind = 'wake' | 'exit' | 'send';

export type ClassifierTestResult = {
  fired: boolean;
  firedScore: number | null;
  peak: number;
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

export function useClassifierTest(kind: ClassifierKind) {
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
    const startMs = Date.now();
    let peak = 0;
    let final = 0;
    let firedScore: number | null = null;
    let fired = false;
    try {
      const emitter = WakeWordModule ? new NativeEventEmitter(WakeWordModule) : null;
      const onDetect = (e: any) => {
        if (abort.cancelled) return;
        if (!fired) {
          fired = true;
          firedScore = typeof e?.score === 'number' ? e.score : null;
        }
      };
      const sub = emitter?.addListener(EVENT_NAME[kind], onDetect);
      try {
        while (!abort.cancelled && Date.now() - startMs < TEST_DURATION_MS) {
          try {
            const scores: any = await WakeWordModule?.getLatestScores?.();
            if (scores) {
              const v = Number(scores[SCORE_FIELD[kind]]) || 0;
              if (v > peak) peak = v;
              final = v;
            }
          } catch (_) {}
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } finally {
        sub?.remove?.();
      }
    } catch (_) {
      // best-effort
    }
    if (abort.cancelled) return;
    setResult({
      fired,
      firedScore,
      peak,
      final,
      durationMs: Date.now() - startMs,
    });
    setRunning(false);
  }, [kind]);

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
}: {
  kind: ClassifierKind;
  labelOverride?: string;
  hintOverride?: string;
}) {
  const { running, result, start } = useClassifierTest(kind);
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
          <Text style={styles.tipNote}>
            Over {(result.durationMs / 1000).toFixed(1)}s. {c.tip}
          </Text>
        </View>
      )}
    </View>
  );
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