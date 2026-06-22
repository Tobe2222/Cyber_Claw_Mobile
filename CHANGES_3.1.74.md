# 3.1.74 — Revert: arena name no longer shows the sprite emoji

## What it does

Reverts the arena-name icon feature added in v3.1.72 / v3.1.73.

Tobe: "And for some reason the arena also. Remove that, i never
asked for that."

The arena name (the "Clawsuu" / "Lamasuu" text floating above each
companion sprite in the WebView) goes back to rendering as a bare
text label with no emoji prefix. The chat message labels and chat
tabs are unchanged — those still show the sprite emoji correctly.

## Reverted changes

### `arena.html` `drawName()`

Removed the `spriteIcon` lookup and the `displayName` composition
that prefixed `c.data.icon` to the name. Now renders just `c.name`,
matching the pre-v3.1.72 behavior.

### `arena.html` `EMBEDDED_CATALOG`

Removed the `icon` and `iconFile` fields from all 5 sprite entries
(fox, boar, deer, hare, black_grouse). They were added in v3.1.73
specifically to support the `drawName()` icon lookup; with that
reverted, the fields are unused dead code. The catalog is back to
the pre-v3.1.72 shape.

The desktop's own catalog at `src/assets/companions/catalog.json`
is unchanged — it still has `icon` and `iconFile` fields. The
broadcast still uses them; only the WebView's bundled copy is
back to its pre-v3.1.72 minimal shape.

## Why I'm reverting

When Tobe said "It should be the same as the chat tab" earlier, I
overinterpreted that to mean every label-like place in the mobile
UI should show the sprite icon — including the arena name. He
meant the chat message labels specifically (which use the same
chain as the chat tab).

The arena name labels serve a different visual role than the chat
labels: they identify the sprite in a 2D game-like scene, where the
sprite itself is already the visual identifier. Adding a text
emoji prefix to the name is redundant for that context, and Tobe
doesn't want it. Fair enough.

## What you should see after install

- Chat message labels: 🐗 Clawsuu / 🐇 Lamasuu (unchanged)
- Chat tabs: 🐗 Clawsuu / 🐇 Lamasuu (unchanged)
- Arena name (top of screen): "Clawsuu" / "Lamasuu" (back to bare
  text, no emoji)

`versionCode` 123 → 124, `package.json` 3.1.73 → 3.1.74.