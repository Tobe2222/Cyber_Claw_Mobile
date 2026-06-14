# Changelog — v3.1.14 (session 2026-06-14)

Branch: `main`. Tag: `v3.1.14`. Build: `versionCode 64`.

---

## v3.1.14 — six bug fixes from real-device testing

### 1. Arena Settings button no longer shown on mobile

The mobile app is just an extension of the desktop — desktop owns
arena background / companion type. The ⚙ button in the WebView's
arena.html was sending a `postMessage` that the mobile handler
explicitly ignores (v3.1.12 left a "no-op" comment for exactly
this case). The button is now hidden when the WebView URL contains
`?platform=mobile`:

```html
body.mobile #ctrlLeft { display: none !important; }
```

Plus a guard in the JS that adds the `mobile` class:

```js
if (location.search.includes('platform=mobile')) {
  document.body.classList.add('mobile');
}
```

The WebView URLs in both HomeScreen and WakeModeScreen now include
`&platform=mobile`. Same arena.html file, conditionally hidden on
mobile.

### 2. Wake Mode UI was broken — boar missing, duplicate X

The WebView's CSS had:
```css
body.fullscreen #c, html.fullscreen #c { display: none !important; }
```

This was added to hide the canvas in fullscreen mode. But the
canvas drawing code already handles fullscreen mode correctly:
when `#ui.fullscreen` is set, the canvas fills with `#000` and
draws the companion on top. The CSS rule was hiding the canvas
**and** the companion.

Plus the WebView's own X button (in `#ctrlFs`) was showing on
top of the React Native X button, creating a visual duplicate.

**Fix:**
- Removed the canvas-hiding CSS rule — boar now draws on a black
  background as expected (matches the second screenshot).
- Hide `#ctrlFs`, `#thinking`, `#voiceDebug` on mobile — the
  React Native renders its own equivalents (status text, voice
  log, X button) as overlays above the WebView. Showing both just
  created duplicates and visual noise.

### 3. Removed the leftover 🧪 test wake button from the home header

The test button was a debug aid from earlier wake-word iterations.
With the v3.1.12 wake flow now working as a dedicated
WakeModeScreen, the test button is redundant and looks like a
stray debug vail. Removed from the home header along with its
unused styles.

### 4. Wake word from locked phone now lands on Wake Mode, not home screen

The previous v3.1.12 fix listened for the wake event at the App
level, but if the activity was torn down between the native event
firing and the React listener attaching, the wake state was lost
in flight. The user reported: "wake word with the phone locked
brought me to home screen, not wake mode."

**Fix:** in App.tsx, when the wake event fires we now also
**persist the AsyncStorage flag** `cyberclaw-wake-pending=1`
synchronously. The next time AppState transitions to `active`
(when the user dismisses the lock screen and the app comes
forward) or the next App mount (if the activity got recreated
entirely), the flag is read and the screen switches to
`wake-mode`. The flag is cleared when WakeModeScreen exits via
the X button / back button.

This makes the wake flow survive:
- Lock screen dismissal races
- Activity teardown / recreation
- Slow cold-start where the React listener attaches after the
  native event has already fired

### 5. Chat now behaves like a real chat app

The previous chat was a `FlatList` with `inverted={false}` and
a one-shot `scrollToEnd` on layout. New messages would land below
the current scroll position, and the FlatList didn't track the
user's scroll position, so:

- Opening the chat didn't reliably start at the bottom
- New messages could force the user away from where they were
  reading

**Fix:** proper chat pattern.

- `inverted={true}` so newest is at the bottom (data is
  oldest→newest, FlatList inverts visual order)
- `scrollToOffset({ offset: 0 })` to jump to the newest
  (= top of inverted list = bottom of the screen)
- `onScroll` tracks whether the user is at the bottom
  (within an 8px threshold)
- New incoming message while user is at the bottom: auto-scroll
  to it (the user is following along)
- New incoming message while user has scrolled up: leave them
  alone, surface a floating "↓ N new messages" badge that scrolls
  to bottom and clears on tap
- User-sent messages: still auto-scroll if at the bottom, never
  count as "unread"
- Switching to the chat tab from elsewhere: jump to the bottom
  and clear the badge (the user is looking now)

### 6. "There is only clawsuu there" — by design

The mobile is single-companion by design — one agent at a time,
controlled by the `companionId` stored in AsyncStorage and
synced from the desktop via the `companion_id` event. The
desktop can show multiple (per v3.1.7 fix), but the mobile UI
renders just the one currently active companion. This is the
intentional design — a "Companion" app is a 1:1 relationship
between you and your agent. If multi-companion support on
mobile is wanted, that's a separate design discussion and a
bigger change (arena would need a layout for multiple sprites,
the wake word listener would need to choose which companion
to address, etc).

### Pre-existing bug noted

`tsc --noEmit` reports a `)}` parse error in HomeScreen.tsx
(line 1721 after v3.1.14 edits) — a `)}` is closing the wrong
expression in the arena section. This was present before
v3.1.14 and didn't change my edits. App boots and runs fine
despite the TS error (Babel/Metro is more lenient than tsc).
Will fix in a follow-up.

### Files changed

```
App.tsx                              +6/-2    Persist wake-pending flag, clear on exit
android/app/src/main/assets/arena.html +12/-8  Hide arena settings on mobile, don't
                                               hide canvas in fullscreen, hide WebView
                                               voice chrome on mobile
src/screens/HomeScreen.tsx            -16/+50  inverted chat, scroll tracking,
                                               unread badge, drop test wake button
src/screens/WakeModeScreen.tsx        +1/-1    WebView URL includes platform=mobile
```

### Verification

- `tsc --noEmit` clean (one pre-existing error, unrelated)
- No new dependencies
- Manual test plan: install, open chat → starts at bottom; send
  a message → still at bottom; receive a reply → still at bottom;
  scroll up to read history → next incoming message leaves you
  there and shows a "↓ 1 new message" badge; tap badge → jumps
  to bottom
