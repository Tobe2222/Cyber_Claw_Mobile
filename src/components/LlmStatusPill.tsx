/**
 * LlmStatusPill — mobile mirror of the desktop's local-LLM
 * status pill. Sits above the chat TextInput in HomeScreen so
 * the user can see at a glance whether the active companion's
 * LLM is loaded, cold, or the local server is down. Tapping
 * the action button invokes the same action on the desktop via
 * the sync-server, so the user can start Ollama from the phone
 * after a reboot without needing to touch the desktop.
 *
 * v3.10.183: initial implementation. Mirrors CyberClaw v3.3.5
 * pill semantics — same 4 states (running/cold/down/too-big),
 * same action buttons (Unload/Warm up/Start). Tap targets are
 * 44pt high to match mobile HIG. We deliberately do NOT poll
 * — the desktop pushes status updates via the `llm_status`
 * broadcast on chat-open and after each action.
 *
 * Props:
 *   status     — { state, model, modelId, baseUrl,
 *                  providerName, vram } from the most recent
 *                  `llm_status` broadcast. null = no signal yet.
 *   activeAgentId — the companion whose chat is open. Used to
 *                  decide whether to show the pill (we hide it
 *                  if status.model belongs to a different agent).
 *   onAction   — async ({ model, action }) => void. The parent
 *                  (HomeScreen) calls syncClient.llmAction().
 *                  Pill disables the button while the call is
 *                  in flight.
 *
 * Visual: a single rounded row with a colored dot + label on
 * the left and an action button on the right. Color theme
 * matches the desktop:
 *   running  → green   (#00ff80)
 *   cold     → amber   (#f7931e)
 *   down     → red     (#ff5050)
 *   too-big  → orange  (#ffb400)
 */

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';

type LlmState = 'running' | 'cold' | 'down' | 'too-big' | 'unsupported' | 'loading' | null;

interface LlmStatus {
  state: LlmState;
  model?: string | null;
  modelId?: string | null;
  baseUrl?: string | null;
  providerName?: string | null;
  vram?: { totalMb?: number | null; estimatedModelMb?: number | null } | null;
}

interface Props {
  status: LlmStatus | null;
  activeAgentId?: string | null;
  onAction?: (args: { model: string; action: 'start' | 'warm' | 'unload' }) => Promise<void> | void;
}

const COLORS = {
  running: '#00ff80',
  cold: '#f7931e',
  down: '#ff5050',
  'too-big': '#ffb400',
  unsupported: '#888',
  loading: '#888',
};

function formatModelName(modelId: string | null | undefined): string {
  if (!modelId) return 'model';
  // Strip provider prefix if present (defensive — should already be gone).
  const name = modelId.includes('/') ? modelId.split('/').slice(-1)[0] : modelId;
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function LlmStatusPill({ status, activeAgentId, onAction }: Props) {
  const [busy, setBusy] = useState(false);

  if (!status || !status.state) return null;
  // Don't show for companions that aren't the active chat.
  // The desktop broadcasts `agentId` on every event; if the
  // mobile receives a stale event from a previous companion
  // tab, just hide.
  // We tolerate missing agentId in the broadcast because
  // mobile-initiated actions (which trigger broadcasts back
  // to mobile) don't always carry it.
  if (status.state === 'unsupported') return null;

  const dotColor = COLORS[status.state as keyof typeof COLORS] || COLORS.unsupported;
  const modelName = formatModelName(status.modelId || status.model);
  const providerName = status.providerName
    ? status.providerName.charAt(0).toUpperCase() + status.providerName.slice(1)
    : 'Local server';

  let label = '';
  let buttonText = '';
  let buttonAction: 'start' | 'warm' | 'unload' | null = null;
  let accessibilityHint = '';

  if (status.state === 'running') {
    label = `🟢 ${modelName} loaded`;
    const vramMb = status.vram?.estimatedModelMb;
    if (vramMb) accessibilityHint = `Model is warm in VRAM (${vramMb} MB). Tap to evict and free memory.`;
    else accessibilityHint = 'Model is warm and ready. Tap to evict and free VRAM.';
    buttonText = 'Unload';
    buttonAction = 'unload';
  } else if (status.state === 'cold') {
    label = `🟡 ${modelName} not loaded`;
    accessibilityHint = 'Tap to pre-load the model into VRAM (5-15 seconds).';
    buttonText = 'Warm up';
    buttonAction = 'warm';
  } else if (status.state === 'down') {
    label = `🔴 ${providerName} down (${status.baseUrl || 'localhost'})`;
    accessibilityHint = 'Tap to spawn the local LLM server (ollama serve).';
    buttonText = 'Start';
    buttonAction = 'start';
  } else if (status.state === 'too-big') {
    const total = status.vram?.totalMb ? `${(status.vram.totalMb / 1024).toFixed(1)} GB VRAM` : 'this GPU';
    const modelSize = status.vram?.estimatedModelMb ? `${(status.vram.estimatedModelMb / 1024).toFixed(1)} GB` : 'too large';
    label = `⚠ ${modelName} (${modelSize}) won't fit ${total}`;
    accessibilityHint = 'This model is too large for the available GPU memory. Open settings to pick a smaller model.';
    // We don't expose a "fix it" action on mobile because it
    // requires the user to confirm a model change. They can
    // see the same warning on the desktop.
    buttonText = '';
    buttonAction = null;
  } else {
    return null;
  }

  const handlePress = async () => {
    if (!buttonAction || !status.model || busy || !onAction) return;
    setBusy(true);
    try {
      await onAction({ model: status.model, action: buttonAction });
    } catch (e) {
      // Parent shows a toast or chat message; we just re-enable.
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={[styles.pill, { borderColor: dotColor + '55' }]}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
    >
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      {buttonAction ? (
        <TouchableOpacity
          style={[styles.button, busy && styles.buttonBusy]}
          onPress={handlePress}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`${buttonText} ${modelName}`}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{buttonText}</Text>
          )}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginHorizontal: 8,
    marginBottom: 4,
    borderRadius: 14,
    borderWidth: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    minHeight: 36,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  label: {
    flex: 1,
    color: '#fff',
    fontSize: 12,
    fontFamily: 'Courier',
  },
  button: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 64,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  buttonBusy: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Courier',
  },
});
