import * as React from "react";

export type Theme = "dark" | "light" | "system";

export const THEME_STORAGE_KEY = "jevonian-theme";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => null,
};

const ThemeProviderContext = React.createContext<ThemeProviderState>(initialState);

function systemTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredTheme(storageKey: string, fallback: Theme): Theme {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage can be blocked; fall through to the default.
  }
  return fallback;
}

/**
 * Applies the theme class to `<html>`.
 *
 * `index.html` runs the same logic inline before React mounts so the first paint
 * already carries the right class and there is no light-mode flash.
 */
export function applyThemeClass(theme: Theme): "dark" | "light" {
  const root = window.document.documentElement;
  const resolved = theme === "system" ? systemTheme() : theme;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  // Keeps native scrollbars, form controls and the canvas in sync.
  root.style.colorScheme = resolved;
  return resolved;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = THEME_STORAGE_KEY,
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() =>
    readStoredTheme(storageKey, defaultTheme),
  );
  const [resolvedTheme, setResolvedTheme] = React.useState<"dark" | "light">(() =>
    typeof window === "undefined" ? "light" : applyThemeClass(readStoredTheme(storageKey, defaultTheme)),
  );

  React.useEffect(() => {
    setResolvedTheme(applyThemeClass(theme));
  }, [theme]);

  // Follow the OS while the user has "system" selected.
  React.useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolvedTheme(applyThemeClass("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const value = React.useMemo<ThemeProviderState>(
    () => ({
      theme,
      resolvedTheme,
      setTheme: (next: Theme) => {
        try {
          window.localStorage.setItem(storageKey, next);
        } catch {
          // Persisting is best-effort; the in-memory value still applies.
        }
        setThemeState(next);
      },
    }),
    [theme, resolvedTheme, storageKey],
  );

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export function useTheme(): ThemeProviderState {
  return React.useContext(ThemeProviderContext);
}
