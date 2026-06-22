# 3.1.71 — Mobile chat message labels use the agent emoji (no more "Clawsuu" without an icon)

## What it fixes

Tobe: "Okey i restarted the desktop and tested. Now the chat icons are
blank." After installing v3.1.70, every chat message label rendered as
"Clawsuu" (or "Lamasuu") with no emoji / icon prefix, both for the
currently selected agent and when switching between companion tabs.

The companion tab bar (at the bottom of the chat tab) was also showing
no icon — that part of the problem is the desktop state not having
been re-broadcast (see "Tab icons" below), but the message labels had
their own independent code-level bug.

## Root cause: the `agentName` short-circuit

`HomeScreen.tsx` `renderItem` built the chat label like this:

```ts
const agentLabel = (() => {
  if (item.isUser) return '👤 You';
  if (item.agentName) return item.agentName;     // ← short-circuit
  if (item.agentId) {
    const a = (agents || []).find(x => x.id === item.agentId);
    if (a) return `${a.emoji || a.icon || '🐾'} ${a.name}`;
    return `🐾 ${item.agentId}`;
  }
  return '🐾 Clawsuu';
})();
```

The `if (item.agentName) return item.agentName` line returned the bare
agent name ("Clawsuu") as soon as the desktop had sent it, never
reaching the v3.1.68 emoji / icon / paw fallback. The desktop
(`app.js:1985`) only sends `agentName: name || null` — i.e. the display
name with no emoji prefix — so the mobile rendered the name exactly
as it received it.

This has technically been a bug since v3.1.15 introduced the
`agentName` field, but it was hidden in two ways:

1. v3.1.68 only recently added the `a.icon` field to the mobile's
   `agents` cache, so the lookup that was supposed to provide the
   emoji finally had data to work with — and it was being skipped.
2. The chat tab bar (the bottom-of-screen tab buttons) uses a
   different render path that already worked, so the bug only showed
   up in the message labels.

## The fix

Always do the cached-`agents` lookup first when we have an `agentId`.
The lookup uses the same `emoji → icon → 🐾` chain as the tab bar.
`item.agentName` becomes a last-resort fallback for messages that have
no `agentId`.

```ts
const agentLabel = (() => {
  if (item.isUser) return '👤 You';
  if (item.agentId) {
    const a = (agents || []).find(x => x.id === item.agentId);
    if (a) return `${a.emoji || a.icon || '🐾'} ${a.name}`;
    if (item.agentName) return item.agentName;
    return `🐾 ${item.agentId}`;
  }
  if (item.agentName) return item.agentName;
  return '🐾 Clawsuu';
})();
```

`versionCode` 120 → 121, `package.json` 3.1.70 → 3.1.71.
