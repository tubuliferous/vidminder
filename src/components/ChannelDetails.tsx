import { useEffect, useState } from "react";
import type { Channel } from "../types";
import { formatAddedAt } from "../utils";

type Props = {
  channel: Channel;
  /// How many videos from this channel are in the library.
  libraryCount: number;
  /// True while a "Catch up" (load older uploads) is running.
  catchingUp: boolean;
  onOpenOnYouTube: () => void;
  onCatchUp: () => void;
  onUnfollow: () => void;
  onSetCategory: (category: string | null) => void;
};

/// Right-panel summary shown when a channel is selected but no video is. Mirrors
/// the VideoDetails layout: a header image, metadata rows, and actions.
export function ChannelDetails({
  channel,
  libraryCount,
  catchingUp,
  onOpenOnYouTube,
  onCatchUp,
  onUnfollow,
  onSetCategory,
}: Props) {
  const [catInput, setCatInput] = useState(channel.category ?? "");
  const [editingCat, setEditingCat] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setCatInput(channel.category ?? "");
    setEditingCat(false);
    setImgFailed(false);
  }, [channel.id]);

  const saveCategory = () => {
    onSetCategory(catInput.trim() || null);
    setEditingCat(false);
  };

  const followedOn = new Date(channel.followed_at * 1000).toLocaleDateString();
  const initial = channel.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="h-full overflow-y-auto border-l border-line bg-surface flex flex-col">
      <div className="p-5 flex flex-col items-center text-center border-b border-line">
        {channel.thumbnail_url && !imgFailed ? (
          <img
            src={channel.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="w-28 h-28 rounded-full object-cover bg-surface-2"
          />
        ) : (
          <div className="w-28 h-28 rounded-full bg-surface-2 text-ink-faint text-3xl font-semibold flex items-center justify-center">
            {initial}
          </div>
        )}
        <h2 className="mt-3 text-[16px] font-semibold leading-snug">
          {channel.name}
        </h2>
        <div className="mt-0.5 text-[12px] text-ink-faint">
          {channel.subscriber_count != null
            ? `${formatCount(channel.subscriber_count)} subscribers`
            : channel.source}
        </div>
        <button
          onClick={onOpenOnYouTube}
          className="mt-3 text-[12px] px-3 py-1.5 rounded-md border border-line text-ink-dim hover:text-ink hover:bg-surface-2 transition"
        >
          Open on YouTube ↗
        </button>
      </div>

      <div className="p-5 space-y-4">
        <dl className="space-y-2 text-[12.5px]">
          <Stat label="In your library" value={`${libraryCount} ${libraryCount === 1 ? "video" : "videos"}`} />
          <Stat
            label="New in inbox"
            value={channel.inbox_count > 0 ? `${channel.inbox_count}` : "None"}
          />
          <Stat label="Following since" value={followedOn} />
          <Stat
            label="Last checked"
            value={
              channel.last_checked_at
                ? formatAddedAt(channel.last_checked_at)
                : "Not yet"
            }
          />
        </dl>

        {channel.description && channel.description.trim() && (
          <div>
            <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-1.5">
              About
            </label>
            <p className="selectable text-[12.5px] leading-relaxed text-ink-dim whitespace-pre-wrap">
              {channel.description.trim()}
            </p>
          </div>
        )}

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-1.5">
            Category
          </label>
          {editingCat ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={catInput}
                onChange={(e) => setCatInput(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveCategory();
                  if (e.key === "Escape") {
                    setCatInput(channel.category ?? "");
                    setEditingCat(false);
                  }
                }}
                placeholder="No category"
                className="flex-1 text-[13px] px-2 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
              />
              <button
                onClick={saveCategory}
                className="text-[12px] px-2.5 rounded-md bg-surface-2 hover:bg-line"
              >
                Save
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingCat(true)}
              className="w-full text-left text-[13px] px-2 py-1.5 rounded-md bg-canvas border border-line hover:border-line-soft text-ink-dim hover:text-ink"
            >
              {channel.category || (
                <span className="text-ink-faint">No category — click to set</span>
              )}
            </button>
          )}
        </div>

        <button
          onClick={onCatchUp}
          disabled={catchingUp}
          className={
            "w-full text-[13px] font-medium py-2 rounded-md border transition " +
            (catchingUp
              ? "border-line bg-surface-2 text-ink-faint cursor-default"
              : "border-accent/40 text-accent hover:bg-accent-dim/40")
          }
          title="Load older uploads from this channel into the inbox (within your lookback window)"
        >
          {catchingUp ? "Catching up…" : "Catch up on older uploads"}
        </button>

        <div className="pt-2 border-t border-line">
          <button
            onClick={onUnfollow}
            className="text-[12px] text-ink-faint hover:text-danger transition"
          >
            Unfollow channel
          </button>
        </div>
      </div>
    </div>
  );
}

/// Compact count label (e.g. 21000000 → "21M", 12300 → "12.3K").
function formatCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink-dim">{value}</dd>
    </div>
  );
}
