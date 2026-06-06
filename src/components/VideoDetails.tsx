import { useEffect, useMemo, useRef, useState } from "react";
import type { Channel, Video } from "../types";
import { formatAddedAt, formatDuration, formatUploadDate } from "../utils";
import { kbd } from "../platform";
import * as api from "../api";

type Props = {
  video: Video;
  knownFolders: string[];
  followedChannels: Channel[];
  /** Every distinct full dotted tag currently in use across the library —
   *  powers nesting-aware autocomplete in the tag editor. */
  allTags: string[];
  /** Replace the full set of tags on this video. The Calibre-style editor
   *  commits the whole set on each Enter/Backspace edit; the parent
   *  canonicalizes via the backend. */
  onSetTags: (video: Video, tags: string[]) => void;
  onSetFolder: (video: Video, folder: string | null) => void;
  onToggleWatched: (video: Video) => void;
  onToggleFavorite: (video: Video) => void;
  onOpen: (video: Video) => void;
  onRequestDelete: () => void;
  onFollowChannel: (video: Video) => void;
};

export function VideoDetails({
  video,
  knownFolders,
  followedChannels,
  allTags,
  onSetTags,
  onSetFolder,
  onToggleWatched,
  onToggleFavorite,
  onOpen,
  onRequestDelete,
  onFollowChannel,
}: Props) {
  const [folderInput, setFolderInput] = useState(video.folder ?? "");
  const [editingFolder, setEditingFolder] = useState(false);

  useEffect(() => {
    setFolderInput(video.folder ?? "");
    setEditingFolder(false);
  }, [video.id]);

  const isFollowed =
    !!video.channel_url && followedChannels.some((c) => c.url === video.channel_url);
  const canFollow = !!video.channel_url && !isFollowed;

  const saveFolder = () => {
    const next = folderInput.trim() || null;
    onSetFolder(video, next);
    setEditingFolder(false);
  };

  return (
    <div className="h-full overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-surface)] flex flex-col">
      <div className="aspect-video w-full bg-black relative shrink-0">
        {video.thumbnail_url ? (
          <img
            src={video.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--color-ink-faint)] text-sm">
            no preview
          </div>
        )}
        <button
          onClick={() => onToggleFavorite(video)}
          title={video.favorite ? "Remove from favorites" : "Add to favorites"}
          className={
            "absolute top-2 right-2 w-8 h-8 rounded-full backdrop-blur-md bg-black/45 hover:bg-black/65 flex items-center justify-center transition " +
            (video.favorite ? "text-[#ffd66e]" : "text-white/85")
          }
        >
          <StarIcon filled={video.favorite} />
        </button>
      </div>

      <div className="p-5 space-y-5">
        <div>
          <h2 className="text-[16px] font-semibold leading-snug">{video.title}</h2>
          <div className="mt-1.5 text-[12.5px] text-[var(--color-ink-dim)] flex flex-wrap items-center gap-x-2 gap-y-1">
            {video.uploader && (
              video.channel_url ? (
                <button
                  onClick={() => api.openInBrowser(video.channel_url!)}
                  className="hover:text-[var(--color-accent)] hover:underline transition-colors"
                  title={`Open ${video.uploader} on YouTube`}
                >
                  {video.uploader}
                </button>
              ) : (
                <span>{video.uploader}</span>
              )
            )}
            {video.uploader && <span className="text-[var(--color-ink-faint)]">·</span>}
            <span>{video.source}</span>
            {video.duration ? (
              <>
                <span className="text-[var(--color-ink-faint)]">·</span>
                <span>{formatDuration(video.duration)}</span>
              </>
            ) : null}
          </div>
          <div className="mt-1 text-[11.5px] text-[var(--color-ink-faint)] flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {video.upload_date && (
              <span title={`Uploaded ${formatUploadDate(video.upload_date)}`}>
                Uploaded {formatUploadDate(video.upload_date)}
              </span>
            )}
            {video.upload_date && (
              <span className="text-[var(--color-ink-faint)]/60">·</span>
            )}
            <span
              title={`Added on ${new Date(video.added_at * 1000).toLocaleString()}`}
            >
              Added {formatAddedAt(video.added_at)}
            </span>
          </div>
          {(canFollow || isFollowed) && (
            <div className="mt-2.5">
              {isFollowed ? (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--color-ink-faint)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
                  Following {video.uploader || "channel"}
                </span>
              ) : (
                <button
                  onClick={() => onFollowChannel(video)}
                  className="text-[12px] px-2.5 py-1 rounded-md border border-[var(--color-accent)]/40 text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/40 transition"
                >
                  + Follow {video.uploader ?? "this channel"}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onOpen(video)}
            className="flex-1 text-[13px] font-medium py-2 rounded-md bg-[var(--color-accent)] text-black hover:brightness-110 transition"
          >
            Play in browser
          </button>
          <button
            onClick={() => onToggleWatched(video)}
            className={
              "text-[13px] py-2 px-3 rounded-md border transition " +
              (video.watched
                ? "border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]"
                : "border-[var(--color-line)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]")
            }
            title={video.watched ? "Mark unwatched" : "Mark watched"}
          >
            {video.watched ? "Watched ✓" : "Mark watched"}
          </button>
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
            Folder
          </label>
          {editingFolder ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                list="folders-list"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveFolder();
                  if (e.key === "Escape") {
                    setFolderInput(video.folder ?? "");
                    setEditingFolder(false);
                  }
                }}
                placeholder="No folder"
                className="flex-1 text-[13px] px-2 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              <datalist id="folders-list">
                {knownFolders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <button
                onClick={saveFolder}
                className="text-[12px] px-2.5 rounded-md bg-[var(--color-surface-2)] hover:bg-[var(--color-line)]"
              >
                Save
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingFolder(true)}
              className="w-full text-left text-[13px] px-2 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] hover:border-[var(--color-line-soft)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
            >
              {video.folder || (
                <span className="text-[var(--color-ink-faint)]">No folder — click to set</span>
              )}
            </button>
          )}
        </div>

        <TagEditor video={video} allTags={allTags} onSetTags={onSetTags} />

        {video.description && (
          <div>
            <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
              Description
            </label>
            <p className="selectable text-[12.5px] leading-relaxed text-[var(--color-ink-dim)] whitespace-pre-wrap line-clamp-[14]">
              {video.description}
            </p>
          </div>
        )}

        {video.category && (
          <div className="text-[12px] text-[var(--color-ink-faint)]">
            <span className="text-[var(--color-ink-faint)]">Category: </span>
            <span className="text-[var(--color-ink-dim)]">{video.category}</span>
          </div>
        )}

        {video.raw_tags.length > 0 && (
          <details className="text-[12px]">
            <summary className="cursor-pointer text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)] select-none">
              Source tags ({video.raw_tags.length})
            </summary>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {video.raw_tags.map((t) => (
                <span
                  key={t}
                  className="text-[11px] px-1.5 py-[1px] rounded text-[var(--color-ink-faint)] bg-[var(--color-surface-2)]"
                >
                  {t}
                </span>
              ))}
            </div>
          </details>
        )}

        <div className="pt-2 border-t border-[var(--color-line)]">
          <button
            onClick={onRequestDelete}
            className="text-[12px] text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] transition"
          >
            Remove from library
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tag editor with Calibre-style nesting-aware autocomplete. Tags are dotted
// (e.g. "science.biology.computational"); typing the parent path then "."
// drills into its children. Tab completes in place; Enter / comma commits a
// chip; Backspace at an empty input removes the last chip.
// ---------------------------------------------------------------------------

function TagEditor({
  video,
  allTags,
  onSetTags,
}: {
  video: Video;
  allTags: string[];
  onSetTags: (video: Video, tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset draft when the selected video changes.
  useEffect(() => {
    setDraft("");
    setHi(0);
  }, [video.id]);

  const normOne = (t: string) =>
    t.split(".").map((s) => s.trim()).filter(Boolean).join(".");

  const commitTags = (next: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of next) {
      const n = normOne(t);
      if (!n) continue;
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(n);
    }
    onSetTags(video, out);
  };

  // Suggestions are anchored to the parent path the user has already typed.
  // "bio" → "biology"; "biology." → "biology.immunology"; "biology.imm" →
  // "biology.immunology". Exact-match-to-draft is filtered so the live
  // suggestion list never duplicates what's fully typed.
  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
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
  }, [draft, allTags]);

  const addFromDraft = () => {
    // Comma-separated entry adds several at once.
    const parts = draft
      .split(/,+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setDraft("");
    setHi(0);
    if (parts.length) commitTags([...video.user_tags, ...parts]);
  };

  const commitSuggestion = (s: string) => {
    setDraft("");
    setHi(0);
    commitTags([...video.user_tags, s]);
  };

  return (
    <div>
      <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
        Tags
      </label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {video.user_tags.length === 0 && (
          <span className="text-[12px] text-[var(--color-ink-faint)]">No tags yet</span>
        )}
        {video.user_tags.map((t) => (
          <span
            key={t}
            className="group flex items-center gap-1 text-[12px] px-2 py-[2px] rounded bg-[var(--color-accent-dim)]/40 text-[var(--color-accent)]"
          >
            #{t}
            <button
              onClick={() => commitTags(video.user_tags.filter((x) => x !== t))}
              className="text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] opacity-0 group-hover:opacity-100 transition"
              title="Remove tag"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          ref={inputRef}
          id="vidminder-tag-input"
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
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
              // Complete in place (shell-style). Repeated Tab on a fully-
              // matched suggestion appends "." so the next Tab drills in.
              e.preventDefault();
              const s = suggestions[hi];
              setDraft(
                draft.trim().toLowerCase() === s.toLowerCase() ? s + "." : s
              );
              setHi(0);
            } else if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addFromDraft();
            } else if (e.key === "Escape" && draft) {
              e.preventDefault();
              setDraft("");
            } else if (e.key === "Backspace" && !draft && video.user_tags.length) {
              commitTags(video.user_tags.slice(0, -1));
            }
          }}
          onBlur={() => {
            // Delay so a suggestion click registers before we clear.
            setTimeout(() => draft.trim() && addFromDraft(), 120);
          }}
          placeholder={`Add a tag — “a.b” for nesting (${kbd("T")} to focus)`}
          className="w-full text-[13px] px-2 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
        />
        {suggestions.length > 0 && (
          <ul className="absolute z-20 left-0 right-0 mt-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] shadow-xl py-1 text-[12.5px] max-h-56 overflow-y-auto">
            {suggestions.map((s, i) => (
              <li
                key={s}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitSuggestion(s);
                }}
                onMouseEnter={() => setHi(i)}
                className={
                  "px-2.5 py-1 cursor-pointer " +
                  (i === hi
                    ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
                    : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)]")
                }
              >
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
