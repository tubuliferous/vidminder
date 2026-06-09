import { useEffect } from "react";
import type { Settings, Theme } from "../settings";
import {
  CHANNEL_LOOKBACK_PRESETS,
  OFFLINE_QUALITY_PRESETS,
  POLL_INTERVAL_PRESETS,
} from "../settings";
import { kbd } from "../platform";

type Props = {
  open: boolean;
  settings: Settings;
  onChange: (next: Partial<Settings>) => void;
  onClose: () => void;
};

const THEMES: { key: Theme; label: string; hint: string }[] = [
  { key: "dark", label: "Dark", hint: "Calm late-night palette" },
  { key: "light", label: "Light", hint: "Bright surfaces" },
  { key: "auto", label: "Auto", hint: "Follow system" },
];

export function SettingsDialog({ open, settings, onChange, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-16 pb-8 bg-black/45 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] max-h-[calc(100vh-6rem)] flex flex-col rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 pb-4 border-b border-line shrink-0">
          <div>
            <h2 className="text-[16px] font-semibold leading-none">Settings</h2>
            <div className="text-[11.5px] text-ink-faint mt-1">
              {kbd(",")} to open · Esc to close
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md text-ink-faint hover:text-ink hover:bg-surface-2 transition"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-6">
        <section className="space-y-2">
          <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-faint">
            Appearance
          </div>
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map((t) => {
              const active = settings.theme === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => onChange({ theme: t.key })}
                  className={
                    "rounded-lg border px-3 py-2.5 text-left transition " +
                    (active
                      ? "border-accent bg-accent-dim/40"
                      : "border-line hover:border-line-soft hover:bg-surface-2")
                  }
                >
                  <div
                    className={
                      "text-[13px] font-medium " +
                      (active ? "text-ink" : "text-ink-dim")
                    }
                  >
                    {t.label}
                  </div>
                  <div className="text-[11px] text-ink-faint mt-0.5">
                    {t.hint}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-6 pt-5 border-t border-line">
          <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-2">
            Channel polling
          </div>
          <select
            value={settings.pollIntervalMinutes}
            onChange={(e) =>
              onChange({ pollIntervalMinutes: parseInt(e.target.value, 10) })
            }
            className="w-full text-[13px] px-2 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
          >
            {POLL_INTERVAL_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="text-[11.5px] text-ink-faint mt-1">
            {POLL_INTERVAL_PRESETS.find(
              (p) => p.value === settings.pollIntervalMinutes
            )?.hint ?? ""}
          </div>
        </section>

        <section className="mt-6 pt-5 border-t border-line">
          <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-2">
            Channel history
          </div>
          <select
            value={settings.channelLookbackDays}
            onChange={(e) =>
              onChange({ channelLookbackDays: parseInt(e.target.value, 10) })
            }
            className="w-full text-[13px] px-2 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
          >
            {CHANNEL_LOOKBACK_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="text-[11.5px] text-ink-faint mt-1">
            How far back to load a channel's videos — applies when you follow a
            channel or run Catch up.{" "}
            {CHANNEL_LOOKBACK_PRESETS.find(
              (p) => p.value === settings.channelLookbackDays
            )?.hint ?? ""}
          </div>
        </section>

        <section className="mt-6 pt-5 border-t border-line">
          <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-2">
            Offline downloads
          </div>
          <select
            value={settings.offlineMaxHeight}
            onChange={(e) =>
              onChange({ offlineMaxHeight: parseInt(e.target.value, 10) })
            }
            className="w-full text-[13px] px-2 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
          >
            {OFFLINE_QUALITY_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="text-[11.5px] text-ink-faint mt-1">
            Default quality for one-click downloads. Nothing downloads
            automatically — use the download button on a video, or right-click it
            to pick a specific resolution.{" "}
            {OFFLINE_QUALITY_PRESETS.find(
              (p) => p.value === settings.offlineMaxHeight
            )?.hint ?? ""}
          </div>
        </section>

        <section className="mt-6 pt-5 border-t border-line">
          <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-2">
            Library
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoFavorite}
              onChange={(e) => onChange({ autoFavorite: e.target.checked })}
              className="mt-0.5 w-4 h-4 accent-accent"
            />
            <span>
              <span className="text-[13px] block">Auto-favorite added videos</span>
              <span className="text-[11.5px] text-ink-faint">
                Star every video automatically when it's added (from drops, paste, or the inbox).
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 cursor-pointer mt-3">
            <input
              type="checkbox"
              checked={settings.showShorts}
              onChange={(e) => onChange({ showShorts: e.target.checked })}
              className="mt-0.5 w-4 h-4 accent-accent"
            />
            <span>
              <span className="text-[13px] block">Show Shorts in lists</span>
              <span className="text-[11.5px] text-ink-faint">
                YouTube Shorts are always fetched in the background; turn this on to
                show them in the inbox and library. They never count toward the “new”
                badge.
              </span>
            </span>
          </label>
        </section>

        <section className="mt-6 pt-5 border-t border-line text-[11.5px] text-ink-faint leading-relaxed">
          <div className="font-semibold text-ink-dim mb-1">Tips</div>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>Drop a video URL anywhere to add it to your list.</li>
            <li>Drop a channel URL (<code className="text-ink-dim">youtube.com/@channel</code>) to follow it.</li>
            <li>Drag videos onto a tag or Favorites in the sidebar.</li>
            <li>Enter opens the selected video on YouTube · double-click plays the download if there is one.</li>
            <li>{kbd("Z")} undoes any change · Delete removes the highlighted video · {kbd("Delete")} deletes the selected tag folder.</li>
          </ul>
        </section>
        </div>
      </div>
    </div>
  );
}
