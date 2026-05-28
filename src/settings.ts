import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "auto";

export type Settings = {
  theme: Theme;
  autoFavorite: boolean;
  /// How often the app polls followed channels for new uploads, in minutes.
  /// 0 disables auto-polling — the user can still hit Refresh manually.
  pollIntervalMinutes: number;
};

const DEFAULTS: Settings = {
  theme: "auto",
  autoFavorite: false,
  pollIntervalMinutes: 30,
};

export const POLL_INTERVAL_PRESETS: { value: number; label: string; hint: string }[] = [
  { value: 10, label: "Every 10 minutes", hint: "Aggressive — best for high-frequency channels" },
  { value: 30, label: "Every 30 minutes", hint: "Default — balances freshness and quietness" },
  { value: 60, label: "Hourly", hint: "Lighter on YouTube and your laptop" },
  { value: 180, label: "Every 3 hours", hint: "Once or twice during a typical session" },
  { value: 360, label: "Every 6 hours", hint: "Mostly passive" },
  { value: 0, label: "Manual only", hint: "Never poll automatically — Refresh button only" },
];

const STORAGE_KEY = "vidminder.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* localStorage can fail in private browsing — silently ignore */
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "auto") {
    const isLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    root.setAttribute("data-theme", isLight ? "light" : "dark");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

// Apply persisted theme as early as possible to avoid a flash on load.
export function initThemeFromStorage() {
  applyTheme(loadSettings().theme);
}

export function useSettings(): [Settings, (next: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  useEffect(() => {
    saveSettings(settings);
    applyTheme(settings.theme);
  }, [settings]);

  useEffect(() => {
    if (settings.theme !== "auto") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => applyTheme("auto");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [settings.theme]);

  const update = (next: Partial<Settings>) => {
    setSettings((cur) => ({ ...cur, ...next }));
  };

  return [settings, update];
}
