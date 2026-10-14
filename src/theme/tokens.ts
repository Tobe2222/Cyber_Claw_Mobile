/** CyberClaw Mobile — theme tokens v3.10.112: Light/Dark theme support. */

export type ThemeName = 'dark' | 'light' | 'forest';

export const THEME_STORAGE_KEY = 'cyberclaw-mobile-theme';

export const DEFAULT_THEME: ThemeName = 'dark';

/** Dark = the original CyberClaw look. */
export const darkTheme = {
  name: 'dark' as ThemeName,

  // Redesign as the "moon" theme.
  bg: {
    primary: '#050510',       // near-black, deep space
    secondary: '#0a0a18',     // panels
    tertiary: '#15151f',      // elevated (slight blue tint)
    elevated: '#1a1a28',      // popovers
    overlay: 'rgba(247,147,26,0.12)',
    scrim: 'rgba(0,0,0,0.65)',

    // Scene tokens — deep night versions.
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
    // Brighter neon orange.
    accent: '#ff8c1a',
    // Bumped from #cc5528 to #ffaa3f for chat text legibility on the deep-space bg.primary (#050510).
    accentDim: '#ffaa3f',
    accentBright: '#ffc66d',
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

/** Light = "Forest" theme. */
export const lightTheme = {
  name: 'light' as ThemeName,

  // Redesign as the "sun" theme.
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
    // CyberClaw orange stays as the primary accent — brand identity, not theme-specific.
    accent: '#f7931a',        // CyberClaw orange (the brand)
    // v3.10.133: bumped from #cc5528 to #d97e0e for chat
    // text legibility in light mode. The previous
    // #cc5528 was readable but visually heavy — bumped to
    // a slightly brighter, warmer orange so companion
    // messages pop the same way the dark-mode companion
    // text does after the v3.10.133 fix.
    accentDim: '#d97e0e',
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

/** Forest theme — the middle option, between sun and moon. */
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
    // CyberClaw orange stays as the primary accent — the brand identity is independent of theme.
    accent: '#f7931a',        // CyberClaw orange
    // v3.10.133: bumped from #cc5528 to #d97e0e for chat
    // text legibility in forest mode. Same rationale as
    // light mode — see lightTheme.accentDim above.
    accentDim: '#d97e0e',
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
    // Scene tokens — sky / ground / forest palette.
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
