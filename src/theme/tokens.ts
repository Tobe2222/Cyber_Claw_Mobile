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
    cyanSoft: 'rgba(0,212,255,0.10)',
    cyanGlow: 'rgba(0,212,255,0.30)',

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
    borderFocus: '#00d4ff',
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

  // v3.10.113: increased forest + sky presence. The previous
  // v3.10.112 palette was too cream/white-centric — the bg was
  // almost white and the section cards were pure white, so the
  // whole screen read as "white + green accents" rather than
  // "forest + sky." Tobe's feedback 2026-07-30: ‘I would like
  // more sky and forest, not just white.’ So:
  //   - bg.primary is no longer near-white. It's a soft sage
  //     that immediately reads as forest.
  //   - bg.secondary (cards) is a paler mint with a sky-ward
  //     gradient into the bg.tertiary hue.
  //   - bg.tertiary is a deeper sage for elevated surfaces.
  //   - bg.elevated is the sky hue — for top-of-stack popovers.
  //   - input.bg is now a pale sky tint, not pure white.
  //   - The brand.cyan / brand.info get more saturation so the
  //     sky-blue accents actually read as sky.
  bg: {
    primary: '#e3ecd9',       // soft sage — main app background (the "forest floor")
    secondary: '#eaf2dd',     // cards — slightly lighter mint, reads as moss-lit
    tertiary: '#d4e3c4',      // elevated — deeper sage for inputs/inputs-container
    elevated: '#dbe9f0',     // popovers — the "sky" tint
    overlay: 'rgba(45,90,61,0.08)',
    scrim: 'rgba(30,55,40,0.32)',
  },

  border: {
    subtle: '#b8c9a6',        // slightly more visible against softer bg
    mid: '#8aa478',           // forest mid-green, used for active borders
    strong: '#5b7a4a',        // deep forest, used for headers/section titles
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

    // Sky blue secondary — bumped saturation so it actually
    // reads as sky. v3.10.112 #3a7ca5 was too gray.
    cyan: '#3d8fc4',
    cyanDim: '#2a6fa0',
    cyanSoft: '#cfe4f3',      // pale sky tint for backgrounds
    cyanGlow: 'rgba(61,143,196,0.18)',

    // Semantic — softer for light bg
    success: '#15803d',
    successSoft: 'rgba(21,128,61,0.10)',
    danger: '#b91c1c',
    dangerSoft: 'rgba(185,28,28,0.08)',
    warning: '#b45309',
    info: '#2d7cb8',
    infoSoft: 'rgba(45,124,184,0.10)',
  },

  rarity: {
    common: '#6b7280',
    uncommon: '#2d7a3d',
    rare: '#3d8fc4',
    epic: '#2d5a3d',
    legendary: '#b45309',
    mythic: '#be185d',
  },

  input: {
    bg: '#eaf4f9',             // pale sky — distinct from card bg
    border: '#8aa478',         // forest green border
    borderFocus: '#3d8fc4',    // sky blue on focus
    placeholder: '#7a8b7c',
  },
  scrollbar: {
    track: '#d4e3c4',
    thumb: '#8aa478',
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
};
