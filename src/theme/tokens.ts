/**
 * CyberClaw Mobile — theme tokens
 *
 * v3.10.112: Light/Dark theme support. Two named palettes
 * (dark = default, light = "Forest"). The ThemeContext (see
 * ./ThemeContext.tsx) selects one and exposes its tokens via
 * `useTheme()`. Screens should import colors from here, not
 * hardcode hex literals.
 *
 * Migration guide when converting a StyleSheet:
 *   const styles = StyleSheet.create({
 *     root: { backgroundColor: '#0a0a0a' },  // OLD
 *   });
 *
 *   const styles = makeStyles((t) => ({
 *     root: { backgroundColor: t.bg.primary },  // NEW
 *   }));
 *
 *   Then in the component:
 *     const { theme, styles } = useThemedStyles(makeStyles);
 *
 * Or if you don't want themed styles right now:
 *   const t = useTheme();
 *     <View style={{ backgroundColor: t.bg.primary }} />
 *
 * Important: existing rules say "shared AsyncStorage keys must
 * have one canonical constant" (see MEMORY.md 2026-07-14). The
 * theme key is `cyberclaw-mobile-theme` — defined here once.
 */

export type ThemeName = 'dark' | 'light' | 'forest';

export const THEME_STORAGE_KEY = 'cyberclaw-mobile-theme';

export const DEFAULT_THEME: ThemeName = 'dark';

/**
 * Dark = the original CyberClaw look. Neon orange + cyan on
 * near-black. Preserved exactly as it was before the theme
 * toggle existed. Any token you find in the codebase that
 * doesn't match a key here is a token we haven't migrated yet.
 */
export const darkTheme = {
  name: 'dark' as ThemeName,

  // v3.10.119: redesign as the "moon" theme. Tobe's spec
  // (2026-07-31 16:00 GMT+2): "dark mode to the right
  // (moon) which is mostly black and cyber Orange + other
  // neon colors." The pre-v3.10.119 dark palette was
  // pretty muted — neon orange on near-black, but the
  // accents (cyan, green, etc.) were desaturated.
  // v3.10.119 cranks everything up to cyberpunk-neon:
  //   - bg.primary = near-black (#050510 — deep space)
  //   - bg.tertiary / bg.elevated get a slight blue tint
  //     so the surface elevation reads as "lit by neon"
  //     not "lit by grey"
  //   - scene tokens stay dim-navy (no need to redesign)
  //     but get a deeper sky for night feel
  //   - brand accent gets brighter (ff8c1a vs ff6b35) and
  //     the cyan/success/danger/info all go full neon
  bg: {
    primary: '#050510',       // near-black, deep space
    secondary: '#0a0a18',     // panels
    tertiary: '#15151f',      // elevated (slight blue tint)
    elevated: '#1a1a28',      // popovers
    overlay: 'rgba(247,147,26,0.12)',
    scrim: 'rgba(0,0,0,0.65)',

    // Scene tokens — deep night versions. The sky strip
    // becomes a deep navy gradient (the night sky), the
    // ground becomes a dark earth, the forest becomes a
    // deep dark forest. These stay dim so the home screen
    // doesn't get visually loud.
    sky: '#0c1a2e',
    skyDeep: '#050a18',
    skyLight: '#1a2a4e',
    ground: '#3a2a18',
    groundDark: '#1a0f08',
    groundLight: '#5a3a22',
    forest: '#0a2a14',
    forestDark: '#050f08',
  },

  // Borders
  border: {
    subtle: '#1f1f2f',
    mid: '#2a2a3f',
    strong: '#3a3a55',
    brown: '#3a2a18',
    brownDark: '#1a0f08',
  },

  // Text
  text: {
    primary: '#ffffff',
    secondary: '#d4d4e0',
    muted: '#7a7a8a',
    dim: '#4a4a5a',
    inverse: '#0a0a0a',
  },

  // Brand
  brand: {
    // v3.10.119: brighter neon orange. The pre-v3.10.119
    // #ff6b35 was already saturated; bumping to #ff8c1a
    // makes it pop harder against the deeper bg.primary
    // (#050510 vs the old #0a0a0a). Cyberpunk-neon.
    accent: '#ff8c1a',
    accentDim: '#cc5528',
    accentBright: '#ffaa3f',
    accentGlow: 'rgba(255,140,26,0.5)',

    // v3.10.119: neon cyan, brighter.
    cyan: '#00f0ff',
    cyanDim: '#00a8c0',
    cyanSoft: 'rgba(0,240,255,0.12)',
    cyanGlow: 'rgba(0,240,255,0.40)',

    // Semantic — neon variants
    success: '#22ff88',        // neon green
    successSoft: 'rgba(34,255,136,0.12)',
    danger: '#ff2d6f',        // neon pink (cyberpunk-danger)
    dangerSoft: 'rgba(255,45,111,0.12)',
    warning: '#ffd000',        // neon yellow
    info: '#00d4ff',          // neon blue
    infoSoft: 'rgba(0,212,255,0.12)',
  },

  // Rarity (RPG) — neon variants for cyberpunk feel
  rarity: {
    common: '#7a7a8a',
    uncommon: '#22ff88',
    rare: '#00f0ff',
    epic: '#ff8c1a',
    legendary: '#ffd000',
    mythic: '#ff2d6f',
  },

  // Misc
  input: {
    bg: '#15151f',
    border: '#2a2a3f',
    borderFocus: '#ff8c1a',   // orange focus ring (cyberpunk)
    placeholder: '#4a4a5a',
  },
  scrollbar: {
    track: '#0a0a18',
    thumb: '#2a2a3f',
  },
} as const;

/**
 * Light = "Forest" theme. Inspired by Norwegian forests in
 * summer light:
 *   - sky blue accents (--sky-*)
 *   - deep forest greens (--forest-*)
 *   - warm cream backgrounds (--cream-*)
 * Readable dark green text on light background. Tested at
 * 13px body text against WCAG AA (4.5:1).
 *
 * If you tweak these numbers, also update the card-side
 * comparison chart in DESIGN.md.
 */
export const lightTheme = {
  name: 'light' as ThemeName,

  // v3.10.119: redesign as the "sun" theme. Tobe's spec
  // (2026-07-31 16:00 GMT+2): "light mode (sun) which is
  // light colors, white and light blue etc." The v3.10.113
  // sage-cream palette read as "forest floor" — it was
  // meant to complement the dark "forest" companion theme,
  // but Tobe now wants a true light/bright option, not a
  // second forest variant. The sun theme should feel like
  // a clear bright day:
  //   - bg.primary = pure white (not cream/sage)
  //   - bg.secondary = very pale gray (subtle card lift)
  //   - bg.tertiary = pale blue (sky-tinted elevated)
  //   - bg.elevated = pure white (popovers)
  //   - scene tokens (sky/ground/forest) all move toward
  //     sky-blue tones — the home screen becomes "white
  //     page with blue sky accents" instead of "cream
  //     page with brown earth accents"
  //   - border tokens move toward pale blue
  //   - brand accent stays CyberClaw orange (brand
  //     identity) but accentBright becomes sky-blue so
  //     secondary actions don't shout orange
  bg: {
    primary: '#ffffff',       // pure white — main app background
    secondary: '#f8fafc',     // very pale gray — cards / panels
    tertiary: '#e0f2fe',      // pale blue — elevated surfaces (sky-tinted)
    elevated: '#ffffff',      // pure white — popovers
    overlay: 'rgba(30,58,138,0.08)',
    scrim: 'rgba(15,23,42,0.32)',

    // Scene tokens — sky tones (sun theme reads as
    // "white page, blue sky strip above arena").
    sky: '#bfdbfe',           // pale sky for the strip
    skyDeep: '#60a5fa',       // deeper sky for gradient mid
    skyLight: '#eff6ff',      // lightest sky for the very top
    ground: '#fef3c7',        // pale tan (sun-warmed earth)
    groundDark: '#fcd34d',    // medium tan for shadows
    groundLight: '#fefce8',   // palest tan for lit areas
    forest: '#bbf7d0',        // light leafy green (decorative)
    forestDark: '#86efac',    // medium green for shadows
  },

  border: {
    subtle: '#e2e8f0',        // very pale gray-blue
    mid: '#bfdbfe',           // pale blue
    strong: '#60a5fa',        // medium blue
    brown: '#d4b896',         // tan (warm border)
    brownDark: '#a47e54',
  },

  text: {
    primary: '#0c1a2a',       // deep navy — high-contrast on white
    secondary: '#1e3a5a',     // dark blue
    muted: '#64748b',         // medium slate
    dim: '#94a3b8',           // light slate
    inverse: '#ffffff',
  },

  brand: {
    // CyberClaw orange stays as the primary accent —
    // brand identity, not theme-specific. AccentBright
    // becomes sky-blue so non-primary CTAs don't shout
    // orange.
    accent: '#f7931a',        // CyberClaw orange (the brand)
    accentDim: '#cc5528',
    accentBright: '#3d8fc4',  // sky blue for secondary actions
    accentGlow: 'rgba(247,147,26,0.18)',

    // Sky-blue secondary palette — bumped saturation
    // over the v3.10.112 values so the sky-blue accents
    // actually read as sky on white bg.
    cyan: '#3d8fc4',
    cyanDim: '#2a6fa0',
    cyanSoft: '#dbeafe',
    cyanGlow: 'rgba(61,143,196,0.18)',

    // Semantic — bright but readable on white
    success: '#16a34a',
    successSoft: 'rgba(22,163,74,0.10)',
    danger: '#dc2626',
    dangerSoft: 'rgba(220,38,38,0.10)',
    warning: '#d97706',
    info: '#0891b2',
    infoSoft: 'rgba(8,145,178,0.10)',
  },

  rarity: {
    common: '#64748b',
    uncommon: '#16a34a',
    rare: '#0891b2',
    epic: '#7c3aed',
    legendary: '#d97706',
    mythic: '#db2777',
  },

  input: {
    bg: '#ffffff',             // pure white input
    border: '#bfdbfe',         // pale blue border
    borderFocus: '#3d8fc4',    // sky blue on focus
    placeholder: '#94a3b8',
  },
  scrollbar: {
    track: '#f8fafc',
    thumb: '#bfdbfe',
  },
} as const;

/**
 * Forest theme — the middle option, between sun and moon.
 *
 * v3.10.119: NEW theme. Tobe's spec (2026-07-31 16:00
 * GMT+2): "Forest mode (forest) which is in the middle.
 * Where we create it to look like an actual forest or a
 * tree in graphics/looks. Green around the arena, Brown
 * in the chat area for a tree trunk, and green under
 * there again for bushes/foliage. And blue and white as
 * sky above the arena."
 *
 * The whole point of this theme is the COMPOSITION, not
 * the individual tokens. The token values are designed
 * so the home screen reads as "looking up at the sky
 * through a forest canopy, with a tree trunk in front of
 * you." Visually:
 *
 *   ┌─────────────────────────────┐  <- sky strip (sky/skyDeep)
 *   │   sky strip (pale blue)     │
 *   ├─────────────────────────────┤
 *   │  ┏━━━━━━━━━━━━━━━━━━━━━━━┓  │
 *   │  ┃     ARENA             ┃  │  <- arena frame: forest green
 *   │  ┃   (forest fill)       ┃  │
 *   │  ┗━━━━━━━━━━━━━━━━━━━━━━━┛  │
 *   ├─────────────────────────────┤  <- companion tab bar: brown bark
 *   │      🍖 🌄 (tab buttons)   │
 *   ├─────────────────────────────┤
 *   │                             │
 *   │   CHAT (brown trunk cavity) │  <- chat list: brown ground
 *   │                             │
 *   │   [user] [clawsuu] [user]  │
 *   │                             │
 *   ├─────────────────────────────┤
 *   │   bushes/foliage (green)    │  <- below chat: forest green
 *   └─────────────────────────────┘
 *
 * Token-by-token:
 *   - bg.primary: forest green (the foliage around the chat)
 *   - bg.secondary: lighter green for cards
 *   - bg.tertiary: deeper green for elevated surfaces
 *   - sky/skyDeep/skyLight: pale blue for the sky strip
 *   - ground/groundDark/groundLight: warm brown (tree trunk)
 *   - forest/forestDark: vibrant green for the arena frame
 *   - border.brown/brownDark: bark-colored borders
 *   - text.primary: cream-white (readable on both green + brown)
 *   - brand.accent: stays CyberClaw orange (brand identity)
 */
export const forestTheme = {
  name: 'forest' as ThemeName,

  bg: {
    primary: '#5b8c5a',       // forest green — foliage around the chat
    secondary: '#6da56b',     // lighter green — cards
    tertiary: '#4a7549',      // deeper green — elevated surfaces
    elevated: '#7eb47d',      // light green — popovers
    overlay: 'rgba(31,61,40,0.12)',
    scrim: 'rgba(10,26,15,0.45)',

    // Sky tones — pale blue for the sky strip above
    // the arena (the v3.10.115 skyStrip + skyStripCloud).
    sky: '#c8e0f0',           // pale sky
    skyDeep: '#7fb0d0',       // mid-sky for gradient
    skyLight: '#e8f4fa',      // lightest sky

    // Ground tones — warm brown for the tree trunk
    // cavity (chat list area) + the companion tab bar.
    ground: '#a47e54',        // warm brown
    groundDark: '#5b3e1f',    // deep bark
    groundLight: '#d4b896',   // pale bark

    // Forest tones — vibrant green for the arena
    // frame + foliage under the chat.
    forest: '#3d6b4a',        // vibrant forest green
    forestDark: '#1f3d28',    // deep forest
  },

  border: {
    subtle: '#7eb47d',        // light green
    mid: '#5b8c5a',           // mid forest green
    strong: '#1f3d28',        // deep forest
    brown: '#7a5635',         // bark brown
    brownDark: '#4a2f15',
  },

  text: {
    primary: '#f8f8f4',       // cream-white — readable on green/brown
    secondary: '#d4d4cc',
    muted: '#a8a89c',
    dim: '#7a7a70',
    inverse: '#1a2e1f',       // dark green for text on light surfaces
  },

  brand: {
    // CyberClaw orange stays as the primary accent — the
    // brand identity is independent of theme. AccentBright
    // becomes bark-brown so secondary actions don't shout
    // orange over the green/brown scene.
    accent: '#f7931a',        // CyberClaw orange
    accentDim: '#cc5528',
    accentBright: '#d4b896',  // pale bark for secondary actions
    accentGlow: 'rgba(247,147,26,0.30)',

    // Sky-blue secondary (matches the sky strip)
    cyan: '#7fb0d0',
    cyanDim: '#5a8aa8',
    cyanSoft: '#cfe4f3',
    cyanGlow: 'rgba(127,176,208,0.25)',

    // Semantic — readable on green/brown scene
    success: '#22ff88',        // neon green (pops on brown)
    successSoft: 'rgba(34,255,136,0.15)',
    danger: '#ff5a5a',
    dangerSoft: 'rgba(255,90,90,0.15)',
    warning: '#ffd000',
    info: '#7fb0d0',
    infoSoft: 'rgba(127,176,208,0.15)',
  },

  rarity: {
    common: '#a8a89c',
    uncommon: '#22ff88',
    rare: '#7fb0d0',
    epic: '#f7931a',
    legendary: '#ffd000',
    mythic: '#ff5a8a',
  },

  input: {
    bg: '#1a3a1f',             // deep forest — cream-white text contrasts well
    border: '#5b8c5a',         // mid forest border
    borderFocus: '#f7931a',    // orange focus ring
    placeholder: '#a8a89c',
  },
  scrollbar: {
    track: '#5b3e1f',
    thumb: '#a47e54',
  },
} as const;

export type Theme = {
  readonly name: ThemeName;
  readonly bg: {
    readonly primary: string;
    readonly secondary: string;
    readonly tertiary: string;
    readonly elevated: string;
    readonly overlay: string;
    readonly scrim: string;
    // v3.10.115: scene tokens — sky / ground / forest palette.
    // These don't have to match across dark and light themes
    // (dark uses dim navy variants, light uses the colorful
    // palette) — the type just says "all strings exist".
    readonly sky: string;
    readonly skyDeep: string;
    readonly skyLight: string;
    readonly ground: string;
    readonly groundDark: string;
    readonly groundLight: string;
    readonly forest: string;
    readonly forestDark: string;
  };
  readonly border: {
    readonly subtle: string;
    readonly mid: string;
    readonly strong: string;
    // v3.10.115: earth-tone borders
    readonly brown: string;
    readonly brownDark: string;
  };
  readonly text: {
    readonly primary: string;
    readonly secondary: string;
    readonly muted: string;
    readonly dim: string;
    readonly inverse: string;
  };
  readonly brand: {
    readonly accent: string;
    readonly accentDim: string;
    readonly accentBright: string;
    readonly accentGlow: string;
    readonly cyan: string;
    readonly cyanDim: string;
    readonly cyanSoft: string;
    readonly cyanGlow: string;
    readonly success: string;
    readonly successSoft: string;
    readonly danger: string;
    readonly dangerSoft: string;
    readonly warning: string;
    readonly info: string;
    readonly infoSoft: string;
  };
  readonly rarity: {
    readonly common: string;
    readonly uncommon: string;
    readonly rare: string;
    readonly epic: string;
    readonly legendary: string;
    readonly mythic: string;
  };
  readonly input: {
    readonly bg: string;
    readonly border: string;
    readonly borderFocus: string;
    readonly placeholder: string;
  };
  readonly scrollbar: {
    readonly track: string;
    readonly thumb: string;
  };
};

export const themes: Record<ThemeName, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  forest: forestTheme,
};
