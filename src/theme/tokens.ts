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

export type ThemeName = 'dark' | 'light';

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

  // Backgrounds
  bg: {
    primary: '#0a0a0a',       // main app background
    secondary: '#0c0c10',     // panels / cards
    tertiary: '#1a1a22',      // elevated surfaces
    elevated: '#222',         // even higher (popovers)
    overlay: 'rgba(0,0,0,0.35)',
    scrim: 'rgba(0,0,0,0.55)',
  },

  // Borders
  border: {
    subtle: '#1f1f1f',
    mid: '#333',
    strong: '#444',
  },

  // Text
  text: {
    primary: '#e8e8ec',
    secondary: '#aaa',
    muted: '#888',
    dim: '#555',
    inverse: '#0a0a0a',
  },

  // Brand
  brand: {
    // Originals — kept as aliases for code that still references them
    accent: '#ff6b35',        // orange
    accentDim: '#cc5528',
    accentBright: '#f7931e',
    accentGlow: 'rgba(255,107,53,0.5)',

    // Secondary
    cyan: '#00d4ff',
    cyanDim: '#0099bb',

    // Semantic
    success: '#4ade80',
    successSoft: 'rgba(34,197,94,0.12)',
    danger: '#dc2626',
    dangerSoft: 'rgba(220,38,38,0.12)',
    warning: '#f59e0b',
    info: '#3b82f6',
    infoSoft: 'rgba(59,130,246,0.12)',
  },

  // Rarity (RPG)
  rarity: {
    common: '#9ca3af',
    uncommon: '#4ade80',
    rare: '#00d4ff',
    epic: '#ff6b35',
    legendary: '#f7931e',
    mythic: '#f472b6',
  },

  // Misc
  input: {
    bg: '#1a1a22',
    border: '#333',
    placeholder: '#555',
  },
  scrollbar: {
    track: '#0c0c10',
    thumb: '#333',
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

  bg: {
    primary: '#f5f7f0',       // warm cream — main app background
    secondary: '#ffffff',     // panels / cards
    tertiary: '#eaeee0',      // elevated surfaces (slightly darker cream)
    elevated: '#e0e8d4',      // highest elevation (subtle moss tint)
    overlay: 'rgba(45,90,61,0.06)',
    scrim: 'rgba(45,90,61,0.18)',
  },

  border: {
    subtle: '#dfe5d2',
    mid: '#c5d0b3',
    strong: '#a8b894',
  },

  text: {
    primary: '#1a2e1f',       // near-black green
    secondary: '#3d4f3e',
    muted: '#5c6b5e',
    dim: '#8a958a',
    inverse: '#f5f7f0',
  },

  brand: {
    // Forest green primary (instead of neon orange)
    accent: '#2d5a3d',
    accentDim: '#1f4029',
    accentBright: '#3a7a52',
    accentGlow: 'rgba(45,90,61,0.18)',

    // Sky blue secondary (instead of neon cyan)
    cyan: '#3a7ca5',
    cyanDim: '#2a5d80',

    // Semantic — softer for light bg
    success: '#15803d',
    successSoft: 'rgba(21,128,61,0.10)',
    danger: '#b91c1c',
    dangerSoft: 'rgba(185,28,28,0.08)',
    warning: '#b45309',
    info: '#2563eb',
    infoSoft: 'rgba(37,99,235,0.10)',
  },

  rarity: {
    common: '#6b7280',
    uncommon: '#15803d',
    rare: '#3a7ca5',
    epic: '#2d5a3d',
    legendary: '#b45309',
    mythic: '#be185d',
  },

  input: {
    bg: '#ffffff',
    border: '#c5d0b3',
    placeholder: '#8a958a',
  },
  scrollbar: {
    track: '#eaeee0',
    thumb: '#c5d0b3',
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
  };
  readonly border: {
    readonly subtle: string;
    readonly mid: string;
    readonly strong: string;
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
};
