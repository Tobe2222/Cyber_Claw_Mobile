# 3.10.94 — Personalize screen polish: preview frame, 2-col traits, drop LLM, reorder overview

Tobe's v3.10.93 feedback (4 fixes, all in one pass):

> "also make the behaviours smaller and 2 or 3 in a row. Also
> put this companion edit in the top of the companion settings.
> We can remove LLM options on the mobile end, that can be
> desktop only. And use the frame of the sprite selected like
> the desktop has. A preview frame."

## What ships

### (1) Personalize card is now first on the companion settings page

`src/screens/CompanionSettingsScreen.tsx` — the four cards on
the per-companion overview (Edit/Personalize, Wake, Exit,
Voice) were reordered so Edit/Personalize is at the top. The
sub-description was updated to drop "model" from the list
(since LLM options are gone on mobile now).

### (2) Preview frame for the selected sprite

`src/screens/CompanionEditScreen.tsx` — new "🖼️ Preview"
section between Sprite picker and Size. A 200×200 dark
centered box mirroring the desktop's
`#forge-companion-viewer` (`border: 2px solid border-dark`,
`border-radius: 10px`, `background: rgba(0,0,0,0.3)`).

Renders the selected sprite's emoji at `scale × 16px`
(clamped 16–128px), so the user can see "this is what the
sprite looks like at scale N" without leaving the screen.
The label below the frame shows the sprite name + current
scale (e.g. "Fox · 4×").

The mobile doesn't ship the desktop's pixel sprite
renderer (the PNG atlas isn't bundled), so the emoji at
scaled-up size is the closest faithful preview. On a
saving event, the desktop regenerates the avatar and
the new sprite shows in the mobile's next broadcast.

### (3) Compact 2-column trait grid

`src/screens/CompanionEditScreen.tsx` — traits are now in
a `flexDirection: 'row', flexWrap: 'wrap'` grid with
`width: '48%'` per card (so 2 per row, matching the
desktop forge's `grid-template-columns: 1fr 1fr`).

Dropped the description text from each card (the bulky
bit) and the padding/font. With 9 traits that's 4 rows
+ a single half-width orphan. The full description
still lives in the `TRAITS` table at the top of the
file for any future long-press tooltip.

### (4) LLM options removed from mobile

`src/screens/CompanionEditScreen.tsx` — the entire "🧠
Models" section + the `ModelPicker` component + all
model state (`primaryModel`, `secondaryModel`,
`customModel`, `useCustomModel`) + the
`MODEL_OPTIONS` constant + ~80 lines of styles. The
patch no longer includes model fields. The desktop's
Companion Forge remains the source of truth for which
model each companion uses.

The desktop's `sprite_config_sync` whitelist (in
`sync-server.js`) still accepts `primaryModel` and
`secondaryModel`, so a future "also let the phone pick
a model" reversal is a one-component re-add (the patch
would include those fields again, the desktop would
apply them, no server changes needed).

## What the user sees

Open Settings → tap a companion → see four cards in this
order:

1. **Edit / Personalize** (orange, was last)
2. **Wake settings** (blue)
3. **Exit settings** (orange-red)
4. **Voice settings** (green)

Tap Edit / Personalize. The screen is:

- 📛 Name
- 🐾 Sprite (5 cards, gold border on selected)
- 🖼️ Preview (200×200 dark box, emoji at scale × 16px,
  label below)
- 📐 Size (single slider, 1–8)
- 💬 Chattiness (single slider, 1–5, with description)
- 🎭 Behaviour Traits (2-col grid, 9 traits, no
  descriptions, checkboxes)
- 💾 Save

No more "🧠 Models" section. The desktop's Companion
Forge has the model picker.

## Lessons

**"Same options on both surfaces" is a goal, not a rule.**
Tobe's original ask was "the same options". After using
it for a day, the conclusion is "the same options that
make sense on this surface" — the model picker is the
desktop's concern (the catalog has 8+ models and a
custom-model free-form input; on a phone that takes
~1KB of vertical space for something the user rarely
touches). The mobile now edits what's useful on mobile
(name, sprite, scale, traits, chattiness) and the
desktop keeps the LLM picker. The sync protocol
didn't need any change — the whitelist is permissive
on both sides.

**Live previews turn two controls into one feature.**
The desktop's `#forge-companion-viewer` shows the pixel
sprite at the chosen scale. Without a live preview, the
mobile's "Sprite" picker + "Size" slider would be two
independent decisions the user has to make in their
head. With the preview frame, the user picks a sprite
and immediately sees it. Adjusting the size slider
makes the preview grow/shrink. The two controls
collapse into one "how does my companion look" mental
model. The cost: a 200×200 box of vertical space. The
benefit: no more "wait, what does scale 6 look like?"
guessing.

**The description text in a card is a UX tax that
rarely pays off.** The traits had a label ("Sassy") and
a description ("Witty comebacks and attitude"). The
description was 30% of the card height, the label was
all the user actually scanned. Dropping the description
gave us 9 traits in 4 rows (2-col) instead of 9 in 9
rows (1-col) — same information density, half the scroll.
The description still lives in the source as a comment
table; it can come back as a long-press tooltip if the
user ever asks "what's a stoic?".

**"Make X smaller and 2 or 3 in a row" usually means
"you're trying to fit too much in one row".** When the
user asks for a smaller version of a control, the
right answer is often "delete a piece of the control"
(here: the description text), not "shrink the font of
the whole control". Tobe's request for "2 or 3" is a
hint that 1 was too cramped AND that adding 2 was
acceptable. Going to 2 (matching the desktop) was the
right call — 3 would have been too cramped for the
"Adventurous" trait label.
