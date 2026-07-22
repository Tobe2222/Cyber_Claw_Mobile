# v3.10.77 — Quest edit diagnostic rendering update

Companion release to desktop v3.2.17.

Tobe's screenshot at 2026-07-22 20:01 showed
"Couldn't update quest: quest not found" — WITHOUT
the diagnostic info v3.10.74 added. That tells us
his desktop is on v3.2.15 or earlier (the diagnostic
code wasn't deployed). He needs to restart the
desktop.

v3.10.77 just updates the mobile's toast rendering
to handle the richer diagnostic format from
v3.2.17 (id + name pairs + wantedName). The toast
now shows:

> "Couldn't update quest: quest not found · wanted
> id \"X\" for \"CYBERHIVE_WEBSITE V2\", desktop has:
> HIVE_CONTROL (a), CYBERHIVE_WEBSITE V2 (b), Domain
> Redirects (c)"

This makes it obvious when the id is "stale" (pointing
to the right quest but with the wrong id) vs
"genuinely unknown" (the quest doesn't exist).

## Files changed

- `src/screens/QuestsScreen.tsx` — `failedHandler`
  renders id+name pairs and `wantedName` from the
  failure response
- `android/app/build.gradle` — versionCode 301→302,
  versionName 3.10.75→3.10.77
- `package.json` — version 3.10.75→3.10.77

## Lessons

**When diagnostic info didn't show up, that itself
is diagnostic.** Tobe's screenshot showed the toast
WITHOUT the v3.10.74 diagnostic info. That tells us
his desktop is on v3.2.15 or earlier — the diagnostic
code wasn't deployed. Always note "the diagnostic
info is missing" as a clue, not as a bug in the
diagnostic code.

**Diagnostic info should distinguish "wrong target"
from "no target".** The v3.10.74 `available: [ids]`
told you nothing if you didn't know what each id
maps to. v3.10.77 includes the name pairs so the
toast can show "wanted id X for name V2, desktop has:
HIVE_CONTROL (a), CYBERHIVE_WEBSITE V2 (b)" —
makes it obvious: "the id 'b' IS for V2, the user
just has the wrong id for V2" → confirms stale-id
diagnosis.