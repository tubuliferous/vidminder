import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelVideo, Video } from "../types";
import { formatDuration, formatUploadDate } from "../utils";

/** Discriminated pick result: lets App route the user to the right view. */
export type PalettePick =
  | { kind: "library"; video: Video }
  | { kind: "channel"; cv: ChannelVideo };

type Props = {
  open: boolean;
  videos: Video[];
  /** Raw channel inbox items. Videos already in the library
   *  (`in_library === true`) are filtered out so library hits win the dedup. */
  channelVideos: ChannelVideo[];
  onClose: () => void;
  onPick: (pick: PalettePick) => void;
};

type MatchKind = "title" | "description" | "tag" | "uploader";

type Hit =
  | { kind: "library"; video: Video; score: number; match: MatchKind }
  | { kind: "channel"; cv: ChannelVideo; score: number; match: MatchKind };

const MAX_RESULTS = 30;

export function SearchPalette({
  open,
  videos,
  channelVideos,
  onClose,
  onPick,
}: Props) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // URLs already in the library — used to suppress duplicate hits from the
  // channel-inbox source (the same video can show in both during ingest).
  // Library hits always win.
  const libraryUrls = useMemo(
    () => new Set(videos.map((v) => v.url)),
    [videos]
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/).filter(Boolean);
    const out: Hit[] = [];

    // --- Library source -------------------------------------------------
    for (const v of videos) {
      const title = v.title.toLowerCase();
      const description = (v.description ?? "").toLowerCase();
      const uploader = (v.uploader ?? "").toLowerCase();
      const tags = v.user_tags.concat(v.raw_tags).join(" ").toLowerCase();

      const allInTitle = words.every((w) => title.includes(w));
      const allInUploader = words.every((w) => uploader.includes(w));
      const allInTags = words.every((w) => tags.includes(w));
      const allInDesc = words.every((w) => description.includes(w));

      if (allInTitle) {
        const phraseIdx = title.indexOf(q);
        const score =
          1000 -
          (phraseIdx >= 0 ? Math.min(phraseIdx, 200) : 200) -
          (title.length - q.length) * 0.01;
        out.push({ kind: "library", video: v, score, match: "title" });
        continue;
      }
      if (allInUploader) {
        out.push({ kind: "library", video: v, score: 700, match: "uploader" });
        continue;
      }
      if (allInTags) {
        out.push({ kind: "library", video: v, score: 500, match: "tag" });
        continue;
      }
      if (allInDesc) {
        const phraseIdx = description.indexOf(q);
        const score =
          300 - (phraseIdx >= 0 ? Math.min(phraseIdx, 200) : 200) * 0.5;
        out.push({ kind: "library", video: v, score, match: "description" });
      }
    }

    // --- Channel inbox source -------------------------------------------
    // Anything `in_library === true` is already represented by the library
    // pass above, so skip. URL dedup is the belt; in_library is the suspenders
    // — the backend sets in_library, but there's a brief window during ingest
    // when the library row exists before the channel_video row is updated.
    for (const cv of channelVideos) {
      if (cv.in_library) continue;
      if (libraryUrls.has(cv.url)) continue;
      const title = cv.title.toLowerCase();
      const uploader = cv.channel_name.toLowerCase();
      const allInTitle = words.every((w) => title.includes(w));
      const allInUploader = words.every((w) => uploader.includes(w));

      if (allInTitle) {
        const phraseIdx = title.indexOf(q);
        // Slight penalty (-25) vs library so any tie goes to library, but the
        // ordering between channel results stays intact.
        const score =
          1000 -
          (phraseIdx >= 0 ? Math.min(phraseIdx, 200) : 200) -
          (title.length - q.length) * 0.01 -
          25;
        out.push({ kind: "channel", cv, score, match: "title" });
        continue;
      }
      if (allInUploader) {
        out.push({ kind: "channel", cv, score: 675, match: "uploader" });
      }
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, MAX_RESULTS);
  }, [query, videos, channelVideos, libraryUrls]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (results.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = results[activeIdx];
        if (hit) {
          onPick(hitToPick(hit));
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, results, activeIdx, onClose, onPick]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-24 bg-black/45 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[92vw] rounded-xl border border-line bg-surface shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search library + channel inbox by title, uploader, tag…"
            className="flex-1 text-[14px] bg-transparent outline-none placeholder:text-ink-faint"
          />
          <span className="text-[11px] text-ink-faint hidden md:inline">
            ↑↓ navigate · ↵ open · esc close
          </span>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
          {query.trim() === "" ? (
            <EmptyHint videos={videos} inboxCount={channelVideos.length} />
          ) : results.length === 0 ? (
            <div className="px-5 py-8 text-center text-[12.5px] text-ink-dim">
              Nothing matches “{query.trim()}”
            </div>
          ) : (
            results.map((r, i) => (
              <ResultRow
                key={hitKey(r)}
                hit={r}
                idx={i}
                query={query.trim()}
                active={i === activeIdx}
                onHover={() => setActiveIdx(i)}
                onPick={() => {
                  onPick(hitToPick(r));
                  onClose();
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function hitToPick(h: Hit): PalettePick {
  return h.kind === "library"
    ? { kind: "library", video: h.video }
    : { kind: "channel", cv: h.cv };
}

function hitKey(h: Hit): string {
  return h.kind === "library" ? `lib:${h.video.id}` : `inbox:${h.cv.id}`;
}

function EmptyHint({
  videos,
  inboxCount,
}: {
  videos: Video[];
  inboxCount: number;
}) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-dim">
      {videos.length === 0 && inboxCount === 0
        ? "Your library is empty"
        : `Search ${videos.length} library ${
            videos.length === 1 ? "video" : "videos"
          } + ${inboxCount} inbox ${
            inboxCount === 1 ? "item" : "items"
          } by title, uploader, tag, or description.`}
    </div>
  );
}

function ResultRow({
  hit,
  idx,
  query,
  active,
  onHover,
  onPick,
}: {
  hit: Hit;
  idx: number;
  query: string;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const isInbox = hit.kind === "channel";
  const title = hit.kind === "library" ? hit.video.title : hit.cv.title;
  const thumb =
    hit.kind === "library" ? hit.video.thumbnail_url : hit.cv.thumbnail_url;
  const duration =
    hit.kind === "library" ? hit.video.duration : hit.cv.duration;
  const uploader =
    hit.kind === "library"
      ? hit.video.uploader ?? null
      : hit.cv.channel_name;
  const uploadDate =
    hit.kind === "library" ? hit.video.upload_date : hit.cv.upload_date;
  const watched = hit.kind === "library" ? hit.video.watched : false;
  const dur = formatDuration(duration);
  const sourceLabel: Record<MatchKind, string> = {
    title: "Title",
    uploader: "Uploader",
    tag: "Tag",
    description: "Description",
  };
  return (
    <div
      data-idx={idx}
      onMouseEnter={onHover}
      onClick={onPick}
      className={
        "px-4 py-2 flex gap-3 cursor-pointer border-l-2 transition-colors " +
        (active
          ? "bg-surface-2 border-accent"
          : "border-transparent hover:bg-surface-2/60")
      }
    >
      <div className="relative shrink-0 w-[88px] h-[50px] rounded overflow-hidden bg-canvas">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            className={"w-full h-full object-cover " + (watched ? "opacity-50" : "")}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-faint text-[10px]">
            no preview
          </div>
        )}
        {dur && (
          <span className="absolute bottom-0.5 right-0.5 bg-black/75 text-white text-[9px] px-1 rounded">
            {dur}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] leading-snug line-clamp-2">
          <Highlight text={title} query={query} />
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-dim truncate flex items-center gap-1.5">
          {uploader && (
            <>
              <span>{uploader}</span>
              <span className="text-ink-faint">·</span>
            </>
          )}
          {uploadDate && (
            <>
              <span className="text-ink-faint">
                {formatUploadDate(uploadDate, "short")}
              </span>
              <span className="text-ink-faint">·</span>
            </>
          )}
          <span className="text-[10.5px] uppercase tracking-wider text-accent/85">
            {sourceLabel[hit.match]}
          </span>
          {isInbox && (
            <span
              className="text-[9.5px] uppercase tracking-wider px-1.5 py-[1px] rounded bg-accent/15 text-accent"
              title="From a followed channel's inbox — not yet in your library"
            >
              Inbox
            </span>
          )}
        </div>
        {hit.kind === "library" &&
          hit.match === "description" &&
          hit.video.description && (
            <div className="mt-1 text-[11.5px] text-ink-faint line-clamp-1">
              <Highlight
                text={excerptAround(hit.video.description, query)}
                query={query}
              />
            </div>
          )}
      </div>
    </div>
  );
}

function excerptAround(text: string, query: string, radius = 60): string {
  const q = query.toLowerCase();
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + q.length + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let i = 0;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark
        key={idx}
        className="bg-accent/25 text-ink rounded px-[1px]"
      >
        {text.slice(idx, idx + needle.length)}
      </mark>
    );
    i = idx + needle.length;
  }
  return <>{parts}</>;
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-ink-faint"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
