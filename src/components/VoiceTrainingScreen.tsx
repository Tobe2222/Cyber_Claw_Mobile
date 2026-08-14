/**
 * VoiceTrainingScreen — full-page voice-training
 * configuration. v3.10.168.
 *
 * Tobe (2026-08-14):
 *   - "go ahead, and make sure to make the tier user
 *     visible, so they see in voice mode that its
 *     training toward tier 2 or 3 or 4"
 *   - "the training in settings is tier 1"
 *   - "the user does not need to use that if their at
 *     some training threshold"  → B-threshold, hide
 *     when samplesTotal >= 20.
 *   - "perhaps we should have a button for voice
 *     training with explanation within it so to
 *     compact the settings page"
 *
 * This screen owns the long-form explanation card
 * + active enrollment panel + a tier summary. The
 * Settings page now just has a single "🎤 Voice
 * training" button that opens it (hidden once the
 * user is past the B threshold of 20 samples, since
 * natural accumulation handles training from there).
 *
 * Tier ladder (see speakerTier.ts):
 *   Tier 0 — no profile
 *   Tier 1 — locked (5+ samples). This screen is the
 *            "Tier 1 unlock" path.
 *   Tier 2 — 100+ samples
 *   Tier 3 — 1000+ samples (natural lock threshold)
 *   Tier 4 — 5000+ (terminal)
 *
 * Tier upgrades are visible in this screen via the
 * tier summary card + the recent-upgrade list. The
 * native side is still discrete (lock is a one-time
 * step) so the upgrade list is presentational — it
 * logs when each tier is reached but doesn't hot-
 * swap the embedding. v3.10.169 will add the hot-
 * swap.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeModules } from 'react-native';

import { useTheme } from '../theme/ThemeContext';
import ActiveEnrollmentPanel from './ActiveEnrollmentPanel';
import VoiceEnrollmentBar from './VoiceEnrollmentBar';
import {
  deriveSpeakerTier,
  SPEAKER_TIER_DEFINITIONS,
  type SpeakerTier,
} from '../utils/speakerTier';

const { WakeWordModule } = NativeModules;

// Local mirror of the live speaker status — we poll
// because the enrollment UI flips through several
// async states (started → listening → locked) and we
// want the tier summary to update in real time.
type SpeakerStatus = {
  samplesTotal: number;
  hasEnrollment: boolean;
  profileLocked: boolean;
  matchScore: number | null;
};

// v3.10.168: persistent tier-up log. Records the
// timestamp of each tier reached, by polling the
// native status every few seconds. Stored in
// AsyncStorage so the page remembers across
// restarts. Future tier ups are detected by checking
// the current native tier against the highest
// persisted tier.
const TIER_LOG_KEY = 'cyberclaw-speaker-tier-log';
// Tier-up events span minutes (T2 takes ~30 minutes
// of natural use, T3 takes hours). Polling every 5s
// is fine for the running enrollment panel and
// cheap. The tier log is read every poll to detect
// new tier-up events.
const TIER_POLL_INTERVAL_MS = 4000;

type TierEvent = {
  tier: SpeakerTier;
  at: number; // unix ms
  samplesAtEvent: number;
};

export default function VoiceTrainingScreen({
  onBack,
}: {
  onBack: () => void;
}) {
  const { theme: t } = useTheme();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<SpeakerStatus | null>(null);
  const [tierLog, setTierLog] = useState<TierEvent[]>([]);
  const cancelledRef = useRef(false);
  const lastSeenTierRef = useRef<SpeakerTier>(0);

  // Poll native status + tier log.
  useEffect(() => {
    cancelledRef.current = false;
    const tick = async () => {
      if (cancelledRef.current) return;
      try {
        const AsyncStorage = (
          await import('@react-native-async-storage/async-storage')
        ).default;
        const [native, logRaw] = await Promise.all([
          WakeWordModule?.getSpeakerStatus?.(),
          AsyncStorage.getItem(TIER_LOG_KEY).catch(() => null),
        ]);
        if (cancelledRef.current) return;
        if (native) {
          const next: SpeakerStatus = {
            samplesTotal: native.samplesTotal ?? 0,
            hasEnrollment: !!native.hasEnrollment,
            profileLocked: !!native.profileLocked,
            matchScore:
              typeof native.matchScore === 'number' ? native.matchScore : null,
          };
          setStatus(next);
          // Tier-up detection: if our current tier is
          // higher than what's logged as the max, append
          // a new event and persist.
          const currentTier = deriveSpeakerTier({
            samplesTotal: next.samplesTotal,
            profileLocked: next.profileLocked,
          });
          const parsed: TierEvent[] = logRaw ? JSON.parse(logRaw) : [];
          const maxLogged =
            parsed.length > 0
              ? Math.max(...parsed.map((e: TierEvent) => e.tier))
              : 0;
          if (currentTier > maxLogged && currentTier > lastSeenTierRef.current) {
            const event: TierEvent = {
              tier: currentTier,
              at: Date.now(),
              samplesAtEvent: next.samplesTotal,
            };
            const updated = [...parsed, event];
            setTierLog(updated);
            AsyncStorage.setItem(TIER_LOG_KEY, JSON.stringify(updated)).catch(
              () => {},
            );
            // v3.10.168: log-only. v3.10.169 will fire
            // `upgradeSpeakerProfile` here. Today we just
            // remember the moment for the user.
          }
          lastSeenTierRef.current = currentTier;
        }
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, TIER_POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, []);

  const handleClear = useCallback(() => {
    Alert.alert(
      'Clear voice profile?',
      'Wipes the speaker profile + all enrolled samples. The wake word will respond to anyone again until you re-train.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              const AsyncStorage = (
                await import('@react-native-async-storage/async-storage')
              ).default;
              await WakeWordModule?.clearSpeakerEnrollment?.();
              // v3.10.166: also wipe the JS-side active
              // contributions counter so the bar drops to
              // 0/N.
              await AsyncStorage.removeItem('cyberclaw-voice-enrollment-active');
              // v3.10.168: also wipe the tier log on a
              // full clear — the user is starting over.
              await AsyncStorage.removeItem(TIER_LOG_KEY);
              setTierLog([]);
            } catch (e: any) {
              console.warn('[VoiceTraining] clear failed:', e?.message);
            }
          },
        },
      ],
    );
  }, []);

  const styles = makeStyles(t);
  const tier = status
    ? deriveSpeakerTier({
        samplesTotal: status.samplesTotal,
        profileLocked: status.profileLocked,
      })
    : 0;
  const tierDef = SPEAKER_TIER_DEFINITIONS[tier];
  // "Show the active enrollment panel" when the
  // user is below Tier 1 (no profile) OR when they
  // explicitly want to re-train (Tier 1 already
  // achieved). Past Tier 1, the panel is hidden
  // because the bar handles progress visibility.
  const showActiveEnrollment = tier < 2;

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onBack}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>🎤 Voice training</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 24, 60) },
        ]}
      >
        {/* What is voice training? */}
        <View style={styles.introCard}>
          <Text style={styles.introTitle}>What is voice training?</Text>
          <Text style={styles.introBody}>
            The voice profile gates the wake word so it only fires for your
            voice. Other speakers — even ones sitting next to you — won't
            trigger the app. Training is tiered: each tier adds more
            samples, which makes your profile more accurate and reduces
            false triggers.
          </Text>
        </View>

        {/* Current tier summary */}
        <View style={styles.tierSummary}>
          <Text style={styles.tierLabel}>Your tier</Text>
          <Text style={styles.tierBig}>{tierDef.label}</Text>
          <Text style={styles.tierDesc}>{tierDef.description}</Text>
          <View style={styles.tierBarWrap}>
            <VoiceEnrollmentBar variant="compact" />
          </View>
        </View>

        {/* Tier ladder */}
        <View style={styles.ladderCard}>
          <Text style={styles.ladderTitle}>The tiers</Text>
          {SPEAKER_TIER_DEFINITIONS.map(def => {
            const reached = tier >= def.tier;
            const isCurrent = tier === def.tier;
            return (
              <View
                key={def.tier}
                style={[
                  styles.ladderRow,
                  reached && styles.ladderRowReached,
                  isCurrent && styles.ladderRowCurrent,
                ]}
              >
                <Text
                  style={[
                    styles.ladderTier,
                    reached && styles.ladderTierReached,
                  ]}
                >
                  {reached ? '✓' : '○'} {def.label}
                </Text>
                <Text style={styles.ladderThreshold}>
                  ≥ {def.threshold.toLocaleString()} samples
                </Text>
                <Text style={styles.ladderDesc}>{def.description}</Text>
              </View>
            );
          })}
          <Text style={styles.ladderFooter}>
            Tier 4 caps natural training in v3.10.168. Future updates will
            refine the profile continuously past this point.
          </Text>
        </View>

        {/* Active enrollment panel — the Tier 1 unlock
            path. Shown when below Tier 2 (no profile or
            just locked). Past Tier 1, the panel is
            hidden because the bar handles progress
            visibility and the explicit pass doesn't add
            value beyond what natural use already
            provides. */}
        {showActiveEnrollment ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>🚀 Tier 1 unlock</Text>
            <Text style={styles.sectionDesc}>
              Lock your voice profile in ~30 seconds by reading the
              paragraph. Once locked (Tier 1), the wake word only fires for
              you. Tiers 2–4 advance automatically as you use the app.
            </Text>
            <ActiveEnrollmentPanel />
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>🚀 Tier 1 unlocked</Text>
            <Text style={styles.sectionDesc}>
              Your voice profile is locked at Tier 1. Tiers 2–4 advance
              automatically as you keep talking — the bar at the top ticks
              up as samples accumulate.
            </Text>
          </View>
        )}

        {/* Recent tier-up log */}
        {tierLog.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>📜 Tier-up log</Text>
            {tierLog
              .slice()
              .reverse()
              .map((e, i) => {
                const def = SPEAKER_TIER_DEFINITIONS.find(
                  d => d.tier === e.tier,
                )!;
                return (
                  <View
                    key={`${e.at}-${i}`}
                    style={styles.logRow}
                  >
                    <Text style={styles.logTier}>
                      {def.label}
                    </Text>
                    <Text style={styles.logMeta}>
                      {new Date(e.at).toLocaleString()} ·{' '}
                      {e.samplesAtEvent.toLocaleString()} samples
                    </Text>
                  </View>
                );
              })}
          </View>
        ) : null}

        {/* Destructive: clear profile. Hidden when
            there's no profile to clear. */}
        {status?.profileLocked || (status?.samplesTotal ?? 0) > 0 ? (
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={handleClear}
          >
            <Text style={styles.clearBtnText}>
              🗑️ Clear voice profile & start over
            </Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(t: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg.primary },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.bg.tertiary,
    },
    backBtn: { color: t.brand.accent, fontSize: 16, fontWeight: '600', minWidth: 60 },
    title: { color: t.text.primary, fontSize: 18, fontWeight: '700' },
    scroll: { flex: 1 },
    scrollContent: { paddingHorizontal: 20, paddingTop: 20 },
    introCard: {
      backgroundColor: t.bg.secondary,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: t.bg.tertiary,
    },
    introTitle: {
      color: t.brand.accent,
      fontSize: 14,
      fontWeight: '700',
      marginBottom: 8,
      letterSpacing: 0.5,
    },
    introBody: {
      color: t.text.muted,
      fontSize: 13,
      lineHeight: 19,
    },
    tierSummary: {
      backgroundColor: t.bg.tertiary,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: t.bg.tertiary,
    },
    tierLabel: {
      color: t.text.muted,
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      marginBottom: 4,
    },
    tierBig: {
      color: t.brand.accent,
      fontSize: 28,
      fontWeight: '700',
      marginBottom: 8,
    },
    tierDesc: {
      color: t.text.primary,
      fontSize: 13,
      lineHeight: 18,
      marginBottom: 12,
    },
    tierBarWrap: {
      marginTop: 4,
    },
    ladderCard: {
      backgroundColor: t.bg.secondary,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: t.bg.tertiary,
    },
    ladderTitle: {
      color: t.text.muted,
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      marginBottom: 12,
    },
    ladderRow: {
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: 6,
      marginBottom: 4,
      opacity: 0.5,
    },
    ladderRowReached: {
      opacity: 1,
    },
    ladderRowCurrent: {
      backgroundColor: 'rgba(247, 147, 26, 0.15)',
      borderWidth: 1,
      borderColor: 'rgba(247, 147, 26, 0.4)',
    },
    ladderTier: {
      color: t.text.muted,
      fontSize: 14,
      fontWeight: '700',
      marginBottom: 2,
    },
    ladderTierReached: {
      color: t.brand.success,
    },
    ladderThreshold: {
      color: t.text.dim,
      fontSize: 11,
      marginBottom: 2,
    },
    ladderDesc: {
      color: t.text.muted,
      fontSize: 12,
      lineHeight: 17,
    },
    ladderFooter: {
      color: t.text.dim,
      fontSize: 11,
      fontStyle: 'italic',
      marginTop: 8,
    },
    section: {
      backgroundColor: t.bg.secondary,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: t.bg.tertiary,
    },
    sectionTitle: {
      color: t.brand.accent,
      fontSize: 14,
      fontWeight: '700',
      marginBottom: 6,
      letterSpacing: 0.5,
    },
    sectionDesc: {
      color: t.text.muted,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 12,
    },
    logRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 6,
    },
    logTier: {
      color: t.brand.success,
      fontSize: 13,
      fontWeight: '700',
    },
    logMeta: {
      color: t.text.muted,
      fontSize: 12,
    },
    clearBtn: {
      marginTop: 8,
      marginBottom: 16,
      padding: 14,
      borderRadius: 8,
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: 'rgba(239, 68, 68, 0.4)',
      alignItems: 'center',
    },
    clearBtnText: {
      color: '#ef4444',
      fontSize: 14,
      fontWeight: '600',
    },
  });
}
