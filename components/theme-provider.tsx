"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

type Theme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
};

const THEME_STORAGE_KEY = "syncscreen:theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const nextTheme: Theme = storedTheme === "dark" ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      toggleTheme: () => {
        setTheme((currentTheme) => (currentTheme === "light" ? "dark" : "light"));
      }
    }),
    [theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }

  return value;
}
