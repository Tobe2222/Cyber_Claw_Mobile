# 3.1.73 — Chat tab icon + arena name icon (both were missing the icon)

## What it fixes

After installing v3.1.72 + the desktop v3.1.30, the chat message
labels correctly showed the sprite catalog emoji (🐗 for boar /
Clawsuu, 🐇 for hare / Lamasuu, etc.). Two places still didn't:

1. **The chat tabs** at the bottom of the screen — still showing
   "Clawsuu" / "Lamasuu" with no icon.
2. **The arena name** floating above each companion — still showing
   "Clawsuu" / "Lamasuu" with no icon (even though v3.1.72 was
   supposed to fix this).

## Root cause

Two independent misses from the v3.1.68 → v3.1.72 era, both about
the same underlying assumption: that we could render the sprite's
SVG icon directly with React Native's `<Image>` component.

### Chat tabs: SVG-in-Image silently fails

`HomeScreen.tsx` chat tab code (v3.1.70) was:

```js
{(a.iconDataUri || a.iconFile || a.emoji || a.icon) ? (
  (a.iconDataUri || a.iconFile) ? (
    <Image source={{ uri: a.iconDataUri || a.iconFile }} ... />
  ) : (
    <Text style={styles.companionTabEmoji}>{a.emoji || a.icon}</Text>
  )
) : null}
```

The desktop sends `a.iconDataUri` as a base64 SVG data URI
(`data:image/svg+xml;base64,...`). React Native's `<Image>`
component renders PNG / JPEG / WebP / GIF natively, but it does
NOT render SVG. To render SVG you need either `react-native-svg`
(installed as a native module) or a bundling step
(`react-native-svg-transformer`) — neither of which the mobile
project has.

The v3.1.69 → v3.1.70 cycle chased this exact issue (relative
path → data URI), but the underlying "React Native doesn't
render SVG without react-native-svg" problem never went away. The
`<Image>` rendered nothing, and because both branches of the
inner ternary required `a.iconDataUri || a.iconFile` to be
truthy, we never fell through to the `<Text>` emoji fallback.

The chat label (which just uses `<Text>{a.emoji || a.icon}</Text>`)
was unaffected — that's why the labels worked while the tabs
didn't.

### Arena names: the mobile's bundled catalog is missing `icon`

The WebView's `arena.html` carries an `EMBEDDED_CATALOG` constant
so the sprite frame sheets resolve even before the desktop's
`agents_list` broadcast arrives. v3.1.72 added a `c.data.icon`
lookup in `drawName()`, but the **mobile's bundled catalog
predates v3.1.21** when the desktop gained the `icon` field on
each companion entry. None of the 5 sprites in the bundled
catalog had `icon` or `iconFile`, so `c.data.icon` was always
`undefined`, the v3.1.72 `spriteIcon` variable was always `''`,
and the arena fell back to the bare name.

(The desktop's own catalog at `src/assets/companions/catalog.json`
has had the `icon` and `iconFile` fields since v3.1.21 — it just
wasn't kept in sync with the mobile's bundled copy.)

## The fix

### Chat tab

Drop the `<Image>`/SVG path entirely. Always render the catalog
emoji as text:

```js
{(a.emoji || a.icon) ? (
  <Text style={styles.companionTabEmoji}>{a.emoji || a.icon}</Text>
) : null}
```

Same chain as the chat label: per-agent `emoji` override →
catalog `icon` → nothing. The Twemoji SVG rendering was the
right long-term design (smooth at any size, consistent across
devices) but requires `react-native-svg` to actually work, and
adding that native module is out of scope for this fix. The
catalog emoji is the cheap-and-correct alternative.

### Arena name

Update the mobile's bundled catalog (5 sprites: fox, boar, deer,
hare, black_grouse) to include the `icon` and `iconFile` fields,
copied from the desktop's catalog. Now `c.data.icon` resolves
to 🦊 / 🐗 / 🦌 / 🐇 / 🦚 in `drawName()`, and the arena name
prefixes the catalog emoji as v3.1.72 intended.

## What you should see after install

Same as the v3.1.72 table, now actually working:

| Place                    | Before         | After           |
|--------------------------|----------------|-----------------|
| Chat message label       | 🐗 Clawsuu ✓   | 🐗 Clawsuu ✓    |
| Chat tab                 | "Clawsuu"      | 🐗 Clawsuu      |
| Arena name (top of screen) | "Clawsuu"    | 🐗 Clawsuu      |
| Lamasuu equivalents      | "Lamasuu"      | 🐇 Lamasuu      |

`versionCode` 122 → 123, `package.json` 3.1.72 → 3.1.73.

## Files

- `src/screens/HomeScreen.tsx` — companion tab icon branch
  (drop `<Image>`/SVG, use `<Text>` emoji)
- `android/app/src/main/assets/arena.html` — `EMBEDDED_CATALOG`
  updated with `icon` and `iconFile` fields (5 sprites)