# v3.11.42 — Image gallery button + grid overlay

## Summary

A floating "🖼 N" button in the top right of the chat opens
a grid overlay of all images from the current chat. Each
image is tappable to open the existing fullscreen viewer.
Tobe 2026-10-07 16:03: "perhaps a button in the top right
of the chat to view the images stored in the chat."

## Behavior

- **Button placement:** Top right of the chat FlatList,
 similar in style to the existing ↓ jump-to-bottom
 button. Always visible when the chat has at least
 one image.
- **Button content:** "🖼 N" where N is the number of
 images in the current chat. Hidden when N=0 (so
 text-only chats don't have a useless button).
- **Grid overlay:** 3-column grid of image thumbnails.
 Header shows "N images" and a ✕ close button.
 Tapping a thumbnail opens the fullscreen viewer (the
 existing `fullscreenAttachment` state, reuses the
 existing modal).
- **Scope:** Images are from the current chat's full
 bucket (NOT the paginated visible window). So the
 gallery shows ALL images from the chat history,
 even if "Load more" hasn't been clicked.

## Implementation

1. `chatImages` (useMemo, derived from `messages`).
   O(N) walk that filters for `att.type?.startsWith
   ('image/')`. Memoized so it doesn't recompute on
   every render.
2. Floating button (`chatGalleryBtn` / `chatGalleryText`
   styles) in the top right of the chat, positioned
   absolutely. Renders only when `chatImages.length > 0`.
3. Modal (`galleryOpen` state) with a `FlatList` in
   `numColumns={3}` mode rendering the thumbnails.
   Each thumbnail is a `TouchableOpacity` that sets
   `fullscreenAttachment` (reusing the existing
   viewer) and closes the gallery.
4. New styles: `chatGalleryBtn`, `chatGalleryText`,
   `galleryBackdrop`, `galleryHeader`, `galleryTitle`,
   `galleryClose`, `galleryGrid`, `galleryItem`,
   `galleryItemImage`.

## Files touched

- `package.json` — version bump 3.11.41 → 3.11.42
- `android/app/build.gradle` — versionCode 435 → 436,
 versionName 3.11.41 → 3.11.42
- `src/screens/HomeScreen.tsx`:
  - `chatImages` useMemo derivation.
  - `galleryOpen` state.
  - Floating gallery button (in the chat tab's
 JSX, near the existing ↓ button).
  - New `<Modal>` for the grid overlay (after the
 existing fullscreen-attachment modal).
  - 9 new styles for the button + overlay.

## What did NOT change

- The fullscreen attachment viewer is unchanged
 (reused for tapping gallery thumbnails).
- The ↓ jump-to-bottom button is unchanged.
- The Load more pagination (v3.11.41) is unchanged.
- All v3.11.33–v3.11.41 scroll / persistence /
 pagination changes are kept intact.

## Manual QA
- [ ] **Button appears.** Open a chat with at least one
 image. "🖼 N" button is in the top right.
- [ ] **Button hidden for text-only chats.** Open a
 text-only chat. No gallery button visible.
- [ ] **Open gallery.** Tap the button. Grid overlay
 shows all images from the chat.
- [ ] **Tap thumbnail.** Opens the fullscreen image
 viewer. Close it (✕) — returns to the chat (the
 gallery doesn't re-open).
- [ ] **Close gallery.** ✕ in the gallery header
 closes the overlay, returns to the chat.
- [ ] **Gallery reflects pagination.** "Load more"
 doesn't change the gallery (it walks the FULL
 bucket, not the paginated window).
- [ ] **Switch chats.** Switch companion tabs. The
 gallery button updates to show the new chat's
 image count.

## Risk

Low. The gallery is read-only (no mutations to the
chat data). The fullscreen viewer is reused. The
floating button is positioned in a region of the chat
that doesn't conflict with other UI (the ↓ button is
bottom-right; the Load more is at the top-center of
the list; the gallery is top-right).

## Rollback

`git revert v3.11.42` removes the gallery feature.
The button, modal, and styles are all in HomeScreen.tsx
so the rollback is clean.