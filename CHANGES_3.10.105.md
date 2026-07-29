# v3.10.105 — Remove "Recent" pill row above chat input

**What changed:** Removed the orange "Recent:" pill row
that sat above the chat input on the Chat tab. It showed
the last 3 user messages as tappable chips for quick
recovery after an LLM timeout / app crash / network drop.

**Why:** Tobe asked for it gone after seeing it in
v3.10.104: "what is this recent thing in the chat?
Remove that".

**Where it lived:** `src/screens/HomeScreen.tsx`
- JSX block (with the `Recent:` label + horizontal
  ScrollView of TouchableOpacity pills) deleted.
- Style entries (`recentPillsRow`, `recentPillsLabel`,
  `recentPillsContent`, `recentPill`, `recentPillText`,
  `recentPillAgo`) deleted.
- The unused `formatTimeAgoShort` helper is left in
  place for now (only this caller used it; harmless
  if dead).

**Behavior:** Chat tab layout returns to the previous
shape — chat history fills the available space, input
container sits flush above the keyboard. No new feature
is added; this is a pure revert.

**Diff size:** ~120 lines removed, 4 lines of comment
+ 1 version comment added.

versionCode: 329
