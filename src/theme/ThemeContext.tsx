/**
 * CyberClaw Mobile — Theme Context
 *
 * v3.10.112: Light/Dark theme support. Wraps the app with
 * `ThemeProvider`. Children consume the theme via `useTheme()`
 * or `useThemedStyles()`. Theme name is persisted under
 * THEME_STORAGE_KEY (see ./tokens.ts).
 *
 * Initial state: dark (matches the legacy hardcoded look so
 * first-launch is identical to pre-theme-toggle behavior).
 *
 * Why Context and not Redux: theme is read by ~every screen
 * and there's no need for actions/selectors. A single
 * useState + AsyncStorage write is the right granularity.
 *
 * Status bar: the provider also updates the StatusBar
 * barStyle based on the active theme (dark = light-content,
 * light = dark-content). This avoids the "white text on white
 * status bar" footgun we'd hit if a screen forgot to set it.
 */
import React, {
  createContext, useContext, useEffect, useMemo, useState, useCallback,
} from 'react';
import { StatusBar, Appearance, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_THEME, THEME_STORAGE_KEY, ThemeName, Theme, themes,
} from './tokens';

interface ThemeContextValue {
  theme: Theme;
  themeName: ThemeName;
  setTheme: (name: ThemeName) => void;
  toggle: () => void;
  ready: boolean;          // false until storage has been read
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ProviderProps): React.JSX.Element {
  const [themeName, setThemeName] = useState<ThemeName>(DEFAULT_THEME);
  const [ready, setReady] = useState(false);

  // Hydrate from AsyncStorage on mount. Use Appearance too
  // as a fallback for first-time launchers (so a user who'd
  // configured their phone to light mode sees light here).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(THEME_STORAGE_KEY);
        if (cancelled) return;
        if (saved === 'dark' || saved === 'light') {
          setThemeName(saved);
        } else {
          // No saved preference — respect the system theme
          // if it's a matching enum, otherwise default.
          const sys = Appearance.getColorScheme();
          if (sys === 'dark' || sys === 'light') {
            setThemeName(sys);
          }
        }
      } catch (_) {
        // Storage failure — keep default. Not worth a UX
        // crash on a theme setting.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Listen to system theme changes ONLY if the user hasn't
  // explicitly picked one. We track this with a separate key.
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      // If user has an explicit pick, ignore system changes.
      // We don't try to detect "explicit" here — we optimistically
      // follow system until the user taps the toggle. Tapping
      // calls setTheme(name) which persists to storage, so the
      // next mount will respect it.
      if (colorScheme === 'dark' || colorScheme === 'light') {
        // No-op for now; the initial hydrate handles the system
        // fallback. We don't override an in-session user's choice.
      }
    });
    return () => sub.remove();
  }, []);

  const setTheme = useCallback(async (name: ThemeName) => {
    setThemeName(name);
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, name);
    } catch (_) {
      // Persist failure — in-memory state still updated so the
      // UI feels responsive. Next mount will fall back to system.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(themeName === 'dark' ? 'light' : 'dark');
  }, [themeName, setTheme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme: themes[themeName],
    themeName,
    setTheme,
    toggle,
    ready,
  }), [themeName, setTheme, toggle, ready]);

  // Status bar follows the theme. barStyle controls the
  // battery / clock color; backgroundColor is the Android
  // nav bar color (iOS ignores it).
  const isDark = themeName === 'dark';
  const statusBarBg = isDark ? themes.dark.bg.primary : themes.light.bg.primary;

  return (
    <ThemeContext.Provider value={value}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={statusBarBg}
        translucent={false}
      />
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error(
      'useTheme() called outside <ThemeProvider>. ' +
      'Wrap your app root in <ThemeProvider> (see App.tsx).'
    );
  }
  return ctx;
}

/**
 * useThemedStyles — convenience hook for the common case
 * where a screen wants a StyleSheet that depends on the
 * current theme.
 *
 * Usage:
 *   const makeStyles = (t: Theme) => StyleSheet.create({
 *     root: { backgroundColor: t.bg.primary },
 *     title: { color: t.text.primary },
 *   });
 *
 *   function MyScreen() {
 *     const { theme, styles } = useThemedStyles(makeStyles);
 *     return <View style={styles.root}><Text style={styles.title}>...</Text></View>;
 *   }
 *
 * The factory is called every render the theme changes (rare),
 * which is fine — StyleSheet.create is cheap and the result
 * is reused by the standard RN reconciler.
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (t: Theme) => T,
): { theme: Theme; styles: T } {
  const { theme } = useTheme();
  const styles = useMemo(() => StyleSheet.create(factory(theme)), [theme, factory]);
  return { theme, styles };
}

// StyleSheet is imported at the top of this file from
// react-native. Consumers that use useThemedStyles don't need
// to also import StyleSheet unless they build non-themed
// styles alongside.
