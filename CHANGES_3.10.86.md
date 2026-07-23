# v3.10.86 — editor modal: full-screen with safe-area top padding

Tobe reported on v3.10.85 (2026-07-23, ~13:52):

> "@Clawsuu we need a slight UI fix, some padding top
> for the background when editing quests. You can
> see the conflict in the top here."

Screenshot showed the quest editor open over the
quest list. The editor card was positioned at the
bottom of the screen with `marginTop: 'auto'` and
`maxHeight: '90%'` (v3.8.0 bottom-sheet design). The
top ~10% of the scrim showed the dimmed quest list
behind — including the active quest's "🎯 ACTIVE"
banner and the form fields above the editor card.
Combined with Android 15+ edge-to-edge (status bar
drawn on top of the scrim, not above it), the top
of the screen was a confusing mix of dimmed quest
content + status bar + modal — the "conflict" Tobe
saw.

## Root cause

Two compounding design choices from v3.8.0:

1. **Bottom-sheet style editor.** `editorCard` had
   `marginTop: 'auto'` + `maxHeight: '90%'` to make
   it slide up from the bottom and stop at 90% of the
   screen height. The remaining 10% (top of the scrim)
   was visible dimmed content behind.

2. **No safe-area awareness.** The status bar area
   wasn't excluded from the layout. On Android 15+
   edge-to-edge, the status bar is transparent and
   drawn on top of the app content — so the dimmed
   quest list showed through the scrim AND the status
   bar was drawn on top of the scrim. The intersection
   of those two visual layers looked wrong.

Neither issue is a bug per se; they're design
decisions that interacted badly with newer Android
behavior.

## Fix

Two-part change:

**1. Make the editor card full-screen instead of
bottom-sheet.** Dropped `marginTop: 'auto'`,
`maxHeight: '90%'`, and the `borderTopLeftRadius` /
`borderTopRightRadius` (no longer needed for a full-
screen card). Set `height: '100%'` so the card fills
the scrim. This eliminates the visible "dimmed content
behind" area — there's nothing behind anymore.

**2. Add safe-area top padding.** Imported
`useSafeAreaInsets` from `react-native-safe-area-context`,
passed the insets through to `QuestEditorBody` as a
prop, and applied `paddingTop: insets.top + 8` to
the editor card. Now the editor header starts below
the status bar on Android edge-to-edge (and below
the dynamic island / notch on iOS). The card's
background still extends behind the status bar, but
the actual content (header text, form fields) sits in
the safe area.

The 8dp of extra padding above `insets.top` gives a
bit of breathing room between the status bar and the
"✏️ Edit quest" header.

## Side effect: dismiss-on-tap-outside is now a no-op

The editor modal had a Pressable (`StyleSheet.absoluteFill`)
that closed the modal on tap-outside. With the editor
now full-screen, this Pressable is entirely covered by
the editor card — so tapping outside (which is
nowhere) doesn't dismiss.

That's fine because the user has multiple ways to
close:
- The × button in the header (always visible)
- The Cancel button in the footer (always visible)
- The Android back button / gesture-nav back (v3.10.84
  BackHandler)

The dismiss-on-tap-outside was a convenience for the
bottom-sheet design; a full-screen editor doesn't need
it.

## Files changed

- `src/screens/QuestsScreen.tsx`:
  - Imported `useSafeAreaInsets` from
    `react-native-safe-area-context`
  - Added `insets` call at the top of the `QuestsScreen`
    component
  - `QuestEditorBody` accepts an `insets` prop
  - `editorCard` style: removed `marginTop: 'auto'`,
    `maxHeight: '90%'`, `borderTopLeftRadius`,
    `borderTopRightRadius`. Added `height: '100%'`.
  - `editorCard` render: inline `paddingTop:
    insets.top + 8` so the header sits in the safe area
  - Pass `insets={insets}` from the call site to
    `QuestEditorBody`
- `android/app/build.gradle` — versionCode 309→310,
  versionName 3.10.85→3.10.86
- `package.json` — version 3.10.85→3.10.86

## Lessons

**Android edge-to-edge changed the meaning of
"full screen".** Pre-Android-15, the system bars
were opaque and the app content never overlapped
them. Post-Android-15, the bars are transparent
and your app draws behind them — which means your
modal/header/footer layouts need to be safe-area-
aware or they'll visually conflict with the status
bar. `useSafeAreaInsets()` is the canonical fix;
ignore it at your peril on any modal that reaches
the top of the screen.

**Bottom-sheet modals look unfinished when the
top half is just dimmed content.** The original
v3.8.0 design had a reason for being a bottom sheet
(slides up from the bottom, less imposing). But
when the content above the sheet is the same shape
as the content inside the sheet (both are quests,
both have form fields, both have ACTIVE banners),
the eye reads them as a single broken layout
instead of two separate ones. Full-screen modals
spend the screen more aggressively but eliminate
the "what is this area" ambiguity. Default to
full-screen for editing flows unless you have a
specific reason for the bottom-sheet pattern.

**A design that's been fine for years can break
when the OS changes underneath.** v3.8.0's editor
design shipped in 2025 and worked fine. Android 15+
edge-to-edge enforcement (v3.10.80's same trap that
broke keyboard avoidance) made it look broken. Same
fix pattern as v3.10.80: track the OS-level state
explicitly (via `useSafeAreaInsets`) and apply it
manually instead of trusting the OS layout. The
self-contained fix pattern survives OS changes
better than relying on platform defaults.