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
import RNFS from 'react-native-fs';

const { WakeWordModule } = NativeModules;

export type ClassifierKind = 'wake' | 'exit' | 'send';

export type ClassifierTestResult = {
  fired: boolean;
  firedScore: number | null;
  peak: number;
  // v3.10.30: extra diagnostic fields. Peak is the
  // single highest score observed; the test user
  // needs to know whether the model is hearing
  // them at all. With just `peak`, three tries at
  // 0% tell the user nothing — was the mic dead?
  // The wake phrase wrong? The model broken? The
  // user can't tell. The new fields let the
  // result panel say "model heard 2% of your
  // audio" vs "model heard 0% — your mic may not
  // be picking anything up". See process()
  // for the update logic.
  avg: number;
  // Highest single-chunk score. Useful when the
  // user says the wake phrase very briefly —
  // peak avg would be low (most chunks are silence)
  // but max could still be meaningful.
  maxChunk: number;
  // Average RMS energy over the test window. A
  // proxy for "did the mic hear anything at all".
  // Below ~0.005 means the user probably didn't
  // speak, or the mic gain is off, or (most
  // importantly) the OWW listener wasn't actually
  // running during the test — see `owwWasRunning`
  // below.
  avgRms: number;
  // v3.10.31: was the OWW listener actually
  // running during the test? If false, the
  // avgRms=0 result is NOT a mic problem — it's
  // because we never started the mic. Tobe hit
  // this: "Tested 4 times, all 0%" was the
  // listener not being started, not the mic
  // being dead. The result panel now says
  // "OWW listener wasn't running" when false.
  owwWasRunning: boolean;
  // v3.10.50: which wake model was loaded when the
  // test ran. Used by the diagnostic tip to tell
  // the user 'Loaded model: hey_jarvis' (the bundled
  // default) vs 'Loaded model: hey clawsuu' (the
  // user's trained wake). Peak=0 with the wrong model
  // is expected (the model doesn't recognize the
  // user's phrase); peak=0 with the right model is a
  // genuine miss. Without this field the user can't
  // distinguish the two.
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

    // v3.10.45: switched classifier test from live
    // OWW listener to recorder + offline scoring.
    //
    // The live listener path (v3.10.31 fix) called
    // startOwwListening() and polled getLatestScores()
    // + owwVad events for 4 seconds. Worked when the
    // device's AudioRecord init succeeded. Tobe hit
    // a v3.10.44 case where startOwwListening's
    // AudioRecord init would silently fail (no
    // recordingState check, no try/catch on
    // startRecording) while the recorder's
    // AudioRecord worked fine on the same device.
    // Result: every wake test showed "Wake listener
    // wasn't running" with RMS=0/peak=0, even though
    // voice mode worked perfectly (voice mode uses
    // the recorder path, which has the safeguards).
    //
    // The fix: use the recorder path for the test.
    // Record 4s of audio to a temp WAV file, then
    // call WakeWordModule.scoreWavFile(path) to
    // replay the file through the OWW detector
    // chunk-by-chunk and report peak wake score.
    // Same output shape as the live-listener test
    // so the result panel + diagnostic tips work
    // unchanged. RMS comes from the WAV header's
    // PCM data (computed natively in scoreWavFile).
    //
    // For exit/send, same logic applies — both also
    // used to ride on the OWW listener. Routing
    // them through the recorder path is symmetric
    // and consistent.
    //
    // Why the live listener still exists: it's the
    // production wake detection path (HomeScreen's
    // startSampleMatchListener, voice mode's
    // recording turn loop). The test path is a
    // separate, one-shot verification of the
    // trained model — using a recorded file is
    // acceptable for that purpose. The live
    // listener is untouched.
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
    // v3.10.50: track which model the detector was
    // actually using when scoring. Used by the result
    // panel's diagnostic tip to tell the user
    // 'Loaded model: hey_jarvis' vs 'Loaded model: hey
    // clawsuu' so a peak=0 result can be diagnosed
    // without logcat. If the detector was null at
    // score time, detectorLoaded=false; if it was
    // loaded but with a different wakeword than the
    // user's active one, the loadedWakeword differs.
    let loadedWakeword = '';
    let detectorLoaded = false;

    // Use a tmp path inside the cache dir so the
    // file is auto-evicted. The recorder writes
    // 16kHz mono PCM16 WAV — same format
    // scoreWavFile expects.
    const tmpPath = `${RNFS?.CacheDirectoryPath || '/data/data/com.cyberclawmobile/cache'}/wake-test-${Date.now()}.wav`;
    try {
      // 4000ms silence timeout = test ends when the
      // user stops talking (or after 4s of silence).
      // useSmartSilence=true (default) so the
      // recorder works in noisy environments.
      // 4000 = TEST_DURATION_MS; if the user is
      // silent the whole time, the recorder fires
      // its own silence callback at 4s and we get
      // a 4s clip of silence. If the user says the
      // wake phrase then stops, we get a clip up to
      // ~silence-detection-duration of audio. Both
      // cases produce a WAV we can score.
      await WakeWordModule?.startRecorderWithSilence?.(tmpPath, TEST_DURATION_MS, true);
      owwWasRunning = true;
      // Wait for the recorder to finish. It stops
      // either on silence (smart-silence) or on the
      // 4000ms timeout. Either way, stopRecorder()
      // returns the WAV path. We poll for
      // isRecordingState via the getLatestScores
      // shim — actually no, simpler: just sleep for
      // the test window. The recorder auto-stops
      // when silence fires or the timeout hits, but
      // its internal state isn't queryable from JS.
      // A simple setTimeout for TEST_DURATION_MS is
      // good enough.
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
      // Recorder may not have returned a path on
      // auto-stop; fall back to the tmpPath (the
      // recorder writes to that path even if the
      // promise resolves empty in some edge cases).
      wavPath = tmpPath;
    }

    if (wavPath && WakeWordModule?.scoreWavFile) {
      try {
        // v3.10.48: re-init the OWW detector with the
        // user's ACTIVE wake phrase before scoring. The
        // detector was init'd at app start by HomeScreen
        // with the bundled 'hey_jarvis' (hardcoded since
        // v3.2.0). When the user has trained a custom
        // wake ("Hey Clawsuu"), scoreWavFile would score
        // the recorded audio against the wrong model and
        // report peak=0 even when the user said the
        // right phrase. Tobe hit this in v3.10.47: peak
        // 0%, RMS 0.094, listener running — proving mic
        // works but model mismatch was hidden in the
        // wake-test path.
        //
        // If a wakeword is passed via options, initOww
        // here. initOww is idempotent — it replaces the
        // current detector and uses the bundled asset
        // (for 'hey_jarvis' et al.) or the wake-set
        // registry lookup (for custom-trained phrases
        // like 'hey clawsuu' — see
        // OpenWakeWordDetector.findWakeModelByPhrase).
        // For exit/send tests, the wakeword doesn't
        // affect scoring (we read wake/exit/send
        // scores per kind), but re-initing here is
        // harmless — the detector reloads its
        // classifiers and the test still scores the
        // right one.
        //
        // We DON'T restore the original detector after
        // the test. The detector stays re-init'd with
        // the right wake model, which is what the user
        // wants anyway. HomeScreen's startSampleMatch
        // Listener calls initOww('hey_jarvis', ...) on
        // its own when it remounts, so restoring is
        // not necessary.
        const wakewordToScore = options?.wakeword;
        if (wakewordToScore && WakeWordModule?.initOww) {
          try {
            await WakeWordModule.initOww(wakewordToScore, 0.5);
          } catch (e: any) {
            // v3.10.51: don't silently swallow. Log
            // the error so the test's log tab shows
            // what failed. Without this, a failed
            // initOww leaves the detector in a
            // half-initialized state (melspec + embedding
            // but no wake classifier) and the diagnostic
            // tip can only say 'Loaded model: hey_jarvis'
            // without explaining WHY. The log entry
            // makes it clear that initOww was attempted
            // but failed.
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
          // v3.10.50: surface diagnostic info from the
          // native side. The result object now includes
          // `loadedWakeword` (the wakeword the detector
          // is currently using) and `detectorLoaded`
          // (boolean). This lets the result panel tell
          // the user WHICH model the test actually
          // scored against — without this, peak=0
          // always reads as 'model never matched'
          // even when the wrong model was loaded. Tobe
          // hit peak=0 in v3.10.48 testing where the
          // detector may have stayed on 'hey_jarvis'
          // despite initOww being called with the
          // active phrase; this field would have
          // shown that. We attach the loaded wakeword
          // to the result object so the diagnostic
          // tip can include it.
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
  // v3.10.51: added options?.wakeword to the deps.
  // Previously the deps were [kind] only, which meant
  // `start` was the SAME function reference for the
  // entire component lifetime. It captured the
  // options object from the FIRST render — before
  // useEffect had a chance to populate
  // activeWakeDirect. As a result, options.wakeword
  // was undefined at capture time, and the test path
  // skipped initOww entirely. The detector stayed on
  // the bundled 'hey_jarvis' (or whatever was loaded
  // at app start). Tobe's diagnostic on v3.10.50
  // surfaced this perfectly: 'Loaded model: hey_jarvis'
  // meant the JS never re-init'd the detector.
  //
  // Adding options?.wakeword to the deps makes start
  // re-create when the wakeword changes. The hook's
  // consumer (CompanionSettingsScreen) passes
  // { wakeword: activeWakeDirect?.phrase }; on the
  // first render activeWakeDirect is null, so
  // options.wakeword = undefined; on the second
  // render (after useEffect populated it), it's the
  // real phrase. start re-creates and the test path
  // sees the new wakeword.

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
  // v3.10.52: pass wakeword through to the hook.
  // Previously the panel called useClassifierTest(kind)
  // WITHOUT options, so the test path's initOww was
  // never invoked and the detector kept whatever
  // model was loaded at app start (typically the
  // bundled 'hey_jarvis' from HomeScreen's init).
  // The companion-level hook at
  // CompanionSettingsScreen.tsx:213 does pass
  // wakeword correctly — but the wake sub-page
  // renders ClassifierTestPanel directly, not the
  // companion-level hook's start function. So the
  // panel needed its own wakeword prop. Caller
  // (CompanionSettingsScreen wake sub-page) now
  // passes activeWakeDirect?.phrase down to the
  // panel.
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

// v3.10.30: dynamic diagnostic tip. Picks the
// most likely cause based on what the test
// observed, instead of always saying the same
// "aim for 70%" generic message. Categories:
//   1. mic RMS < 0.005 → "mic didn't hear
//      anything — check mic permission, speak
//      louder, or hold phone closer"
//   2. peak < 5% but mic heard plenty → "model
//      didn't recognise this voice. Retrain with
//      cleaner samples"
//   3. peak 5-30% → "model sees something but
//      not enough. Try again with a clearer
//      pronunciation, or retrain"
//   4. peak ≥ 70% but didn't fire → "model
//      matched but the runtime didn't trigger.
//      Threshold is fine; check the
//      silence/gibberish gate"
// The default fallback keeps the original
// "aim for 70%" tip for the common case.
function diagnosticTip(r: ClassifierTestResult, fallback: string): string {
  // v3.10.31: distinguish "mic not running" from
  // "mic dead". The former is the most common
  // cause of "0% on 4 tries" — the OWW listener
  // is only started when the user enters voice
  // mode, so the wake test in CompanionSettings
  // runs against silence unless we explicitly
  // start the listener (which v3.10.31 does).
  // If owwWasRunning is false AFTER the test, the
  // listener never came up — different fix than
  // mic permission/loudness.
  if (!r.owwWasRunning) {
    return '⚠️ Wake listener wasn\u2019t running — opened the mic for this test, but the detector never produced audio. Try entering voice mode first (it primes the listener), then re-run the test.';
  }
  if (r.avgRms < 0.005) {
    return '⚠️ Mic heard almost nothing. Check mic permission, speak louder, or hold the phone closer.';
  }
  if (r.peak < 0.05) {
    // v3.10.50: distinguish 'model never matched the
    // right phrase' from 'wrong model loaded'. Tobe
    // hit peak=0 in v3.10.48 where the detector was
    // probably still on 'hey_jarvis' (bundled default)
    // despite the test calling initOww with the
    // active phrase. The diagnostic tip should tell
    // the user WHICH model scored the audio so they
    // can see at a glance whether the right model
    // was loaded. If loadedWakeword is set and
    // matches the active phrase, it's a genuine
    // miss (retrain needed). If loadedWakeword is
    // 'hey_jarvis' or empty, the test scored against
    // the wrong model.
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