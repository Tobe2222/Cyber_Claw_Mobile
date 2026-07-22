# v3.10.70 — Bottom-input gap fix + companion-reply notifications

Tobe reported two things in one message:

1. "@Clawsuu i also see that there is a gap in the
   bottom, under the chat input field."
2. "And when the companion answers we should get a
   notification on the phone, there it can say which
   companion that has answered etc."

Both are real. Both ship in v3.10.70.

## Bug 1: gap below the chat input field

**Symptom:** on Android, a visible dark band sat
between the chat input row (the orange +/🎙️ buttons,
text field, ▶ send button) and the bottom edge of the
screen.

**Root cause:** the `inputContainer` was a flex-end
child of `KeyboardAvoidingView` with no bottom padding.
The Android system navigation bar (~48dp at the bottom)
occupied that space and was the same dark color as the
app's `#0a0a0a` background, but the app's content did
not extend behind it — so the input row sat at
~48dp above the bottom of the screen with a visible
empty gap.

The React Native `SafeAreaView` component is iOS-only.
HomeScreen wasn't using `useSafeAreaInsets()` from
`react-native-safe-area-context` (already wrapped
around the app in App.tsx).

**Fix:** read `useSafeAreaInsets().bottom` in HomeScreen
and apply it as `paddingBottom` on the `inputContainer`
view:

```tsx
const insets = useSafeAreaInsets();
...
<View style={[styles.inputContainer,
              { paddingBottom: 8 + insets.bottom }]}>
```

The base `paddingVertical: 8` from the style is replaced
with the dynamic `[8 + insets.bottom]` inline override
so the input row's existing top padding stays at 8 (so
it doesn't squash against the divider above) while the
bottom grows by the nav-bar inset on Android. On iOS
with no home indicator, `insets.bottom === 0` and the
behavior is unchanged.

## Bug 2: companion-reply notifications

**Symptom:** when a companion replied and Tobe wasn't
looking at the chat (or the app was in background),
nothing pinged his phone. He had to remember to check.

**Fix:** new system notification fired when:
- Message arrives from a companion (`isUser === false`)
- AND the user isn't actively watching that
  companion's chat (chat tab not active, app
  backgrounded, voice mode open, or a different
  companion's chat is focused)

The notification shows the companion's name as the
title ("Lamasuu replied") and a 140-char preview of
the reply text as the body. Tapping launches the app
to the foreground.

### Native side (`NativeBackgroundModule`)

New method `notifyCompanionReply(agentName: String,
text: String, promise: Promise)`. Creates a new
notification channel `cyberclaw_chat` ("Companion
replies", `IMPORTANCE_DEFAULT`) on first call so the
user can mute chat notifications independently from the
BG-listening / wake channels.

Notification IDs are scoped per companion
(`2000 + agentName.hashCode() % 1000`) so:
- Rapid replies from the SAME companion overwrite
  each other (most recent wins, doesn't spam the
  notification shade)
- Different companions keep their own notifications
  in the shade

Title: `"$agentName replied"`. Body: text truncated to
140 chars + ellipsis. `setAutoCancel(true)` so tapping
dismisses the notification. Tapping launches
`MainActivity` via `getLaunchIntentForPackage`.

### JS side (`HomeScreen.onChat`)

After `appendAgentMessage` runs, if `!msg.isUser` and
the user isn't actively looking at the chat for that
companion, call:

```ts
NativeModules.NativeBackground?.notifyCompanionReply?.(
  agentName,
  preview,
);
```

The "actively looking" check uses refs (no stale
closure):

```ts
const isChatFocused =
  appStateRef.current === 'active' &&
  !fullscreenRef.current &&
  !isWakeWordModeRef.current &&
  activeTabRef.current === 'chat' &&
  aid === activeChatAgentIdRef.current;
```

Added `activeTabRef` (mirror of `activeTab` state) and
a `useEffect` to keep it in sync — same pattern as
`messagesByAgentRef` and `activeChatAgentIdRef`.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - import `useSafeAreaInsets` from
    `react-native-safe-area-context`
  - new `insets` and `activeTabRef` hooks
  - `useEffect` to mirror `activeTab` to `activeTabRef`
  - `inputContainer` gets `paddingBottom: 8 + insets.bottom`
  - `onChat` handler calls `notifyCompanionReply` when
    user isn't actively watching the chat for that
    companion
- `android/app/src/main/java/com/cyberclawmobile/
  NativeBackgroundModule.kt`:
  - new imports for `NotificationChannel`,
    `NotificationManager`, `PendingIntent`,
    `NotificationCompat`
  - `CHAT_CHANNEL_ID` constant
  - new `@ReactMethod notifyCompanionReply`
- `android/app/build.gradle` — versionCode 295→296,
  versionName 3.10.69→3.10.70
- `package.json` — version 3.10.69→3.10.70

## Lessons

**The RN `SafeAreaView` is iOS-only.** If you want
Android nav-bar padding, you need
`useSafeAreaInsets()` from
`react-native-safe-area-context` (or extend the app
behind the system bars and use the system-level inset
detection). Forgetting this leaves an invisible gap at
the bottom on Android.

**"Notifications" is a UX feature, not just a native
plumbing feature.** It's tempting to wire up a
notification channel and forget about WHEN to fire.
But notifications are annoying if they fire when the
user can already see the message. The "actively
looking" check is the user-visible logic — and it's
where most notification bugs come from. Get the
conditions right before you optimize the channel or
the icon.

**Per-resource notification IDs prevent spam without
silencing.** Using a hash of the agent name as the
notification ID means rapid replies from Clawsuu
overwrite each other (most recent wins) but Lamasuu
keeps its own thread of notifications. The user
gets a clean shade without losing the cross-companion
distinction.

**Stable refs for the "what's the user looking at"
check.** The chat-event handler is defined inside the
main `useEffect` and captures a stale closure. Reading
`activeTab` directly would give the value at handler
creation time. The `activeTabRef` mirror pattern
(already used for `messagesByAgentRef` and
`activeChatAgentIdRef`) is the established way.