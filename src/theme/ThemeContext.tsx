/** CyberClaw Mobile — Theme Context v3.10.112: Light/Dark theme support. */
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
    // Cycle through three themes: dark → forest → light → dark.
    const order: ThemeName[] = ['dark', 'forest', 'light'];
    const idx = order.indexOf(themeName);
    const next = order[(idx + 1) % order.length];
    setTheme(next);
  }, [themeName, setTheme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme: themes[themeName],
    themeName,
    setTheme,
    toggle,
    ready,
  }), [themeName, setTheme, toggle, ready]);

  // Status bar follows the theme.
  const isDark = themeName === 'dark';
  const statusBarBg = themes[themeName].bg.primary;

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

/** UseThemedStyles — convenience hook for the common case where a screen wants a StyleSheet that depends on the current theme. */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (t: Theme) => T,
): { theme: Theme; styles: T } {
  const { theme } = useTheme();
  const styles = useMemo(() => StyleSheet.create(factory(theme)), [theme, factory]);
  return { theme, styles };
}

// StyleSheet is imported at the top of this file from react-native.
