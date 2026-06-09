import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "auto";

export type Settings = {
  theme: Theme;
  autoFavorite: boolean;
  /// How often the app polls followed channels for new uploads, in minutes.
  /// 0 disables auto-polling — the user can still hit Refresh manually.
  pollIntervalMinutes: number;
  /// How far back to load a channel's videos when populating saved channels,
  /// in days. Default 14 (2 weeks); larger values pull more upload history.
  channelLookbackDays: number;
  /// Default max resolution (in pixels of height) for one-click offline
  /// downloads. 720 is the default; 0 means audio-only; 99999 means "best
  /// available". The per-video pickers can override this per download.
  offlineMaxHeight: number;
  /// Whether YouTube Shorts appear in the inbox and library lists. Shorts are
  /// always fetched in the background; this only governs their visibility.
  /// Off by default.
  showShorts: boolean;
};

const DEFAULTS: Settings = {
  theme: "auto",
  autoFavorite: false,
  pollIntervalMinutes: 30,
  channelLookbackDays: 14,
  offlineMaxHeight: 720,
  showShorts: false,
};

export const POLL_INTERVAL_PRESETS: { value: number; label: string; hint: string }[] = [
  { value: 10, label: "Every 10 minutes", hint: "Aggressive — best for high-frequency channels" },
  { value: 30, label: "Every 30 minutes", hint: "Default — balances freshness and quietness" },
  { value: 60, label: "Hourly", hint: "Lighter on YouTube and your laptop" },
  { value: 180, label: "Every 3 hours", hint: "Once or twice during a typical session" },
  { value: 360, label: "Every 6 hours", hint: "Mostly passive" },
  { value: 0, label: "Manual only", hint: "Never poll automatically — Refresh button only" },
];

/// How far back to load a channel's videos, in days. Default is 2 weeks (the
/// shortest); longer windows pull more history but take longer to load and only
/// apply when you follow a channel or run Catch up.
export const CHANNEL_LOOKBACK_PRESETS: { value: number; label: string; hint: string }[] = [
  { value: 14, label: "2 weeks", hint: "Default — just the latest uploads" },
  { value: 30, label: "1 month", hint: "A little more backlog" },
  { value: 90, label: "3 months", hint: "A season of uploads" },
  { value: 180, label: "6 months", hint: "Half a year of uploads" },
  { value: 365, label: "1 year", hint: "A full year of history" },
  { value: 730, label: "2 years", hint: "Deeper backfill — slower to load" },
  { value: 1825, label: "5 years", hint: "Most of a channel's history" },
  { value: 3650, label: "10 years", hint: "As far back as practical — slowest to load" },
];

/// The "best available" sentinel — caps nothing (download the highest stream).
export const OFFLINE_BEST = 99999;
/// The audio-only sentinel — extract an mp3 instead of a video file.
export const OFFLINE_AUDIO = 0;

/// Default-download quality presets. `value` is a max height in pixels, with
/// two sentinels: OFFLINE_BEST ("best available") and OFFLINE_AUDIO ("audio
/// only"). Anything above ~720p requires the bundled ffmpeg to merge streams.
export const OFFLINE_QUALITY_PRESETS: { value: number; label: string; hint: string }[] = [
  { value: OFFLINE_BEST, label: "Best available", hint: "Highest resolution — largest files" },
  { value: 2160, label: "4K (2160p)", hint: "Very large files" },
  { value: 1440, label: "1440p", hint: "Large files" },
  { value: 1080, label: "1080p", hint: "Full HD" },
  { value: 720, label: "720p", hint: "Default — good balance" },
  { value: 480, label: "480p", hint: "Smaller files" },
  { value: OFFLINE_AUDIO, label: "Audio only", hint: "MP3 — minimal storage" },
];

/// Human label for a max-height value (e.g. 1080 → "1080p").
export function offlineQualityLabel(h: number): string {
  if (h === OFFLINE_AUDIO) return "Audio";
  if (h >= OFFLINE_BEST) return "Best";
  return `${h}p`;
}

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
