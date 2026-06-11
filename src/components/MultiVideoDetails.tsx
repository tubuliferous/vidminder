import { useEffect, useMemo, useState } from "react";
import type { Video } from "../types";
import { kbdClick, shiftClick } from "../platform";
import { OFFLINE_QUALITY_PRESETS } from "../settings";

type Props = {
  videos: Video[];
  /** Every distinct full dotted tag in use library-wide — fuels the
   *  nesting-aware autocomplete on the bulk-add input. */
  allTags: string[];
  onSetWatched: (videos: Video[], watched: boolean) => void;
  onSetFavorite: (videos: Video[], favorite: boolean) => void;
  onAddTag: (videos: Video[], tag: string) => void;
  onRemoveTag: (videos: Video[], tag: string) => void;
  onDeleteAll: (videos: Video[]) => void;
  onClearSelection: () => void;
  /// The user's default download quality — seeds the batch resolution picker.
  defaultMaxHeight: number;
  /// Download the given videos, each capped at `maxHeight`.
  onBatchDownload: (videos: Video[], maxHeight: number) => void;
  /// Remove the offline downloads (and cancel in-flight ones) for the given
  /// videos. The videos themselves stay in the library.
  onBatchRemoveDownloads: (videos: Video[]) => void;
};

export function MultiVideoDetails({
  videos,
  allTags,
  onSetWatched,
  onSetFavorite,
  onAddTag,
  onRemoveTag,
  onDeleteAll,
  onClearSelection,
  defaultMaxHeight,
  onBatchDownload,
  onBatchRemoveDownloads,
}: Props) {
  const n = videos.length;
  const [tagInput, setTagInput] = useState("");
  const [hi, setHi] = useState(0);
  const [batchChoice, setBatchChoice] = useState<number>(defaultMaxHeight);

  // Offline tallies + the subset that can still be downloaded.
  const offlineReady = videos.filter((v) => v.offline_status === "ready").length;
  const offlineActive = videos.filter((v) => v.offline_status === "downloading").length;
  const downloadable = videos.filter(
    (v) => v.offline_status !== "ready" && v.offline_status !== "downloading"
  );
  // Anything with offline state to clear: a finished file, an in-flight
  // download (cancelled), or a stuck error state.
  const removableDownloads = videos.filter((v) => v.offline_status !== "none");

  // Derive group-level state for the buttons.
  const watchedAll = videos.every((v) => v.watched);
  const watchedNone = videos.every((v) => !v.watched);
  const watchedMixed = !watchedAll && !watchedNone;

  const favoritedAll = videos.every((v) => v.favorite);
  const favoritedNone = videos.every((v) => !v.favorite);
  const favoritedMixed = !favoritedAll && !favoritedNone;

  // Tag breakdown: shared vs partial vs all-distinct
  const { sharedTags, partialTags } = useMemo(() => {
    const counts = new Map<string, { display: string; count: number }>();
    for (const v of videos) {
      const seen = new Set<string>();
      for (const t of v.user_tags) {
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const existing = counts.get(k);
        if (existing) existing.count += 1;
        else counts.set(k, { display: t, count: 1 });
      }
    }
    const shared: string[] = [];
    const partial: { tag: string; count: number }[] = [];
    for (const [, info] of counts) {
      if (info.count === n) shared.push(info.display);
      else partial.push({ tag: info.display, count: info.count });
    }
    shared.sort((a, b) => a.localeCompare(b));
    partial.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    return { sharedTags: shared, partialTags: partial };
  }, [videos, n]);

  useEffect(() => {
    setTagInput("");
    setHi(0);
  }, [videos.map((v) => v.id).join(",")]);

  // Nesting-aware autocomplete. Same logic as the single-video editor's
  // TagEditor — anchored to the dotted parent the user has typed.
  const suggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase();
    if (!q) return [];
    const lastDot = q.lastIndexOf(".");
    const parent = lastDot >= 0 ? q.slice(0, lastDot) : "";
    const frag = lastDot >= 0 ? q.slice(lastDot + 1) : q;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const full of allTags) {
      const fl = full.toLowerCase();
      const segs = fl.split(".");
      const depth = parent ? parent.split(".").length : 0;
      if (parent && segs.slice(0, depth).join(".") !== parent) continue;
      if (segs.length <= depth) continue;
      if (!segs[depth].startsWith(frag)) continue;
      const cand = segs.slice(0, depth + 1).join(".");
      const candOrig = full.split(".").slice(0, depth + 1).join(".");
      if (seen.has(cand) || cand === q) continue;
      seen.add(cand);
      out.push(candOrig);
      if (out.length >= 8) break;
    }
    return out;
  }, [tagInput, allTags]);

  const submitTag = () => {
    const t = tagInput
      .split(".")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(".");
    if (!t) return;
    onAddTag(videos, t);
    setTagInput("");
    setHi(0);
  };

  // Watched / favorite labels & next states
  const watchedLabel = watchedAll ? "Unmark all watched" : "Mark all watched";
  const onClickWatched = () => onSetWatched(videos, !watchedAll);
  const favLabel = favoritedAll ? "Unstar all" : "Star all";
  const onClickFavorite = () => onSetFavorite(videos, !favoritedAll);

  return (
    <div className="h-full overflow-y-auto border-l border-line bg-surface flex flex-col">
      <div className="px-5 pt-5 pb-3 border-b border-line">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-[15px] font-semibold leading-none">
              {n} videos selected
            </h2>
            <div className="text-[11.5px] text-ink-faint mt-1">
              Esc to clear · {kbdClick()} to toggle · {shiftClick} to extend
            </div>
          </div>
          <button
            onClick={onClearSelection}
            className="text-[11.5px] text-ink-faint hover:text-ink transition"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onClickWatched}
            className={
              "text-[12.5px] py-2 px-3 rounded-md border transition inline-flex items-center justify-center gap-1.5 " +
              (watchedAll
                ? "border-line bg-surface-2 text-ink-dim"
                : "border-line text-ink-dim hover:text-ink hover:bg-surface-2")
            }
            title={
              watchedMixed
                ? "Selection has a mix of watched and unwatched — marking all as watched"
                : ""
            }
          >
            {watchedMixed && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent/70" />
            )}
            <span>{watchedLabel}</span>
          </button>
          <button
            onClick={onClickFavorite}
            className={
              "text-[12.5px] py-2 px-3 rounded-md border transition inline-flex items-center justify-center gap-1.5 " +
              (favoritedAll
                ? "border-line bg-surface-2 text-ink-dim"
                : "border-line text-ink-dim hover:text-ink hover:bg-surface-2")
            }
            title={
              favoritedMixed
                ? "Selection has a mix of favorited and not — starring all"
                : ""
            }
          >
            {favoritedMixed && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent/70" />
            )}
            <span>{favLabel}</span>
          </button>
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-1.5">
            Offline
          </label>
          <div className="text-[12px] text-ink-dim mb-2">
            {offlineReady} of {n} downloaded
            {offlineActive > 0 ? ` · ${offlineActive} in progress` : ""}
          </div>
          <div className="flex gap-2">
            <select
              value={batchChoice}
              onChange={(e) => setBatchChoice(parseInt(e.target.value, 10))}
              className="flex-1 text-[13px] px-2 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
              title="Each video downloads at this resolution, or the highest it offers below it"
            >
              {OFFLINE_QUALITY_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              disabled={downloadable.length === 0}
              onClick={() => onBatchDownload(downloadable, batchChoice)}
              className={
                "text-[13px] font-medium py-2 px-3 rounded-md transition " +
                (downloadable.length === 0
                  ? "bg-surface-2 text-ink-faint cursor-default"
                  : "bg-accent text-black hover:brightness-110")
              }
            >
              Download {downloadable.length}
            </button>
          </div>
          {removableDownloads.length > 0 && (
            <button
              onClick={() => {
                const k = removableDownloads.length;
                if (
                  !confirm(
                    `Remove ${k} downloaded ${k === 1 ? "file" : "files"}? The ${
                      k === 1 ? "video stays" : "videos stay"
                    } in your library.`
                  )
                )
                  return;
                onBatchRemoveDownloads(removableDownloads);
              }}
              className="mt-2 text-[12px] text-ink-faint hover:text-danger transition"
            >
              Remove {removableDownloads.length}{" "}
              {removableDownloads.length === 1 ? "download" : "downloads"}
            </button>
          )}
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-1.5">
            Tags
            <span className="ml-2 text-[10px] normal-case tracking-normal text-ink-faint">
              shared · partial
            </span>
          </label>
          {sharedTags.length === 0 && partialTags.length === 0 && (
            <div className="text-[12px] text-ink-faint mb-2">
              None of the selected videos are tagged.
            </div>
          )}
          {sharedTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {sharedTags.map((t) => (
                <span
                  key={"s-" + t}
                  className="group flex items-center gap-1 text-[12px] px-2 py-[2px] rounded bg-accent-dim/40 text-accent"
                  title="Present on all selected videos"
                >
                  #{t}
                  <button
                    onClick={() => onRemoveTag(videos, t)}
                    className="text-ink-faint hover:text-danger opacity-0 group-hover:opacity-100 transition"
                    title={`Remove #${t} from all`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {partialTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {partialTags.map(({ tag, count }) => (
                <span
                  key={"p-" + tag}
                  className="group flex items-center gap-1 text-[12px] px-2 py-[2px] rounded bg-surface-2 text-ink-dim border border-dashed border-line"
                  title={`Present on ${count} of ${n} — click + to add to remaining, × to remove from those that have it`}
                >
                  #{tag}
                  <span className="text-[10px] text-ink-faint tabular-nums">
                    {count}/{n}
                  </span>
                  <button
                    onClick={() => onAddTag(videos, tag)}
                    className="text-ink-faint hover:text-accent opacity-0 group-hover:opacity-100 transition"
                    title={`Add #${tag} to remaining ${n - count}`}
                  >
                    +
                  </button>
                  <button
                    onClick={() => onRemoveTag(videos, tag)}
                    className="text-ink-faint hover:text-danger opacity-0 group-hover:opacity-100 transition"
                    title={`Remove #${tag} from ${count} that have it`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="relative">
            <input
              id="vidminder-tag-input"
              type="text"
              value={tagInput}
              onChange={(e) => {
                setTagInput(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && suggestions.length) {
                  e.preventDefault();
                  setHi((i) => (i + 1) % suggestions.length);
                } else if (e.key === "ArrowUp" && suggestions.length) {
                  e.preventDefault();
                  setHi((i) => (i - 1 + suggestions.length) % suggestions.length);
                } else if (e.key === "Tab" && suggestions[hi]) {
                  e.preventDefault();
                  const s = suggestions[hi];
                  setTagInput(
                    tagInput.trim().toLowerCase() === s.toLowerCase() ? s + "." : s
                  );
                  setHi(0);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  submitTag();
                } else if (e.key === "Escape") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder={`Add a tag to all ${n} — “a.b” for nesting`}
              className="w-full text-[13px] px-2 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
            />
            {suggestions.length > 0 && (
              <ul className="absolute z-20 left-0 right-0 mt-1 rounded-md border border-line bg-surface shadow-xl py-1 text-[12.5px] max-h-56 overflow-y-auto">
                {suggestions.map((s, i) => (
                  <li
                    key={s}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onAddTag(videos, s);
                      setTagInput("");
                      setHi(0);
                    }}
                    onMouseEnter={() => setHi(i)}
                    className={
                      "px-2.5 py-1 cursor-pointer " +
                      (i === hi
                        ? "bg-accent-dim text-ink"
                        : "text-ink-dim hover:bg-surface-2")
                    }
                  >
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="pt-2 border-t border-line">
          <button
            onClick={() => {
              if (
                !confirm(
                  `Remove ${n} ${n === 1 ? "video" : "videos"} from your library?`
                )
              )
                return;
              onDeleteAll(videos);
            }}
            className="text-[12px] text-ink-faint hover:text-danger transition"
          >
            Remove {n} from library
          </button>
        </div>
      </div>
    </div>
  );
}
