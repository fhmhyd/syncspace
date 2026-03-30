"use client";

import { useTheme } from "@/components/theme-provider";

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-label={theme === "light" ? "Enable dark mode" : "Enable light mode"}
      title={theme === "light" ? "Enable dark mode" : "Enable light mode"}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {theme === "light" ? "☾" : "☀"}
      </span>
    </button>
  );
}
