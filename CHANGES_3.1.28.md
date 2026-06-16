# v3.1.28 — drop the mobile-side 6-companion cap, trust the desktop

## What changed

The v3.1.27 mobile added a defensive `MAX_MOBILE_COMPANIONS = 6`
cap on the incoming `agents_list` payload — if the desktop ever
sent more than 6, the mobile would take only the first 6.

The user pointed out (correctly) that the cap belongs on the
desktop, not the mobile. The mobile is a client; the desktop is
the source of truth. Mirroring the cap on the mobile:
- hides desktop-side bugs (e.g. if the cap on the desktop
  ever regressed, the mobile would silently cap and the
  user would think "why does my 7th companion not show up
  on the phone, but it does on the desktop?")
- means the mobile and the desktop disagree on what the
  limit is, which makes the system harder to reason about

The desktop side fix is in `cyberclaw` v3.1.19 (already
shipped on the `feature/companion-improvements` branch). It
caps `visibleOrder` at 6 inside `initArenaCompanions()` and
respects the cap in `applyCompanionVisibility()`. The
mobile broadcast (built from `visibleOrder.map(...)` at the
end of `initArenaCompanions`) only ever carries up to 6
agents.

## What this version does

- Removed the `MAX_MOBILE_COMPANIONS = 6` slice from
  `onAgentsList` in `HomeScreen.tsx`. The mobile now
  uses the list as-is from the desktop.
- The defensive cap comment is replaced with a note
  pointing at the desktop v3.1.19 as the source of the
  cap.

## Files

- `src/screens/HomeScreen.tsx`
  - `onAgentsList` no longer slices the agents array.
    The list from the desktop is used directly.
- `package.json` — bumped to 3.1.28
- `android/app/build.gradle` — versionCode 78,
  versionName 3.1.28
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.28` and `CyberClaw-Android-3.1.28.apk`

## Verification

- `node` parse of the mobile TSX is clean.
- With the desktop at v3.1.19 (already pushed), the
  mobile will see at most 6 agents. The mobile tab bar
  renders them all, the arena swaps between them, and
  everything else (chat, history, settings) is
  unchanged.
- If the desktop ever sent more than 6 again, the mobile
  would now show all of them — which is a feature, not
  a bug; it'd surface the desktop-side regression
  immediately instead of silently clipping.
