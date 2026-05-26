import { useEffect, useMemo, useRef, useState } from "react";
import type { Video } from "../types";
import { formatDuration, formatUploadDate } from "../utils";

type Props = {
  open: boolean;
  videos: Video[];
  onClose: () => void;
  onPick: (video: Video) => void;
};

type Result = {
  video: Video;
  score: number;
  kind: "title" | "description" | "tag" | "uploader";
};

const MAX_RESULTS = 30;

export function SearchPalette({ open, videos, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // Defer focus until the input mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Result[] = [];
    for (const v of videos) {
      const title = v.title.toLowerCase();
      const description = (v.description ?? "").toLowerCase();
      const uploader = (v.uploader ?? "").toLowerCase();
      const tags = v.user_tags.concat(v.raw_tags).join(" ").toLowerCase();

      // Score: title hits dominate, then uploader, then tags, then description.
      // Multi-word query: AND of all words (every word must match somewhere).
      const words = q.split(/\s+/).filter(Boolean);
      const allInTitle = words.every((w) => title.includes(w));
      const allInUploader = words.every((w) => uploader.includes(w));
      const allInTags = words.every((w) => tags.includes(w));
      const allInDesc = words.every((w) => description.includes(w));

      if (allInTitle) {
        // Earlier substring match scores higher; full-phrase match scores higher
        // than scattered word matches.
        const phraseIdx = title.indexOf(q);
        const score =
          1000 - (phraseIdx >= 0 ? Math.min(phraseIdx, 200) : 200) -
          (title.length - q.length) * 0.01;
        out.push({ video: v, score, kind: "title" });
        continue;
      }
      if (allInUploader) {
        out.push({ video: v, score: 700, kind: "uploader" });
        continue;
      }
      if (allInTags) {
        out.push({ video: v, score: 500, kind: "tag" });
        continue;
      }
      if (allInDesc) {
        const phraseIdx = description.indexOf(q);
        const score =
          300 - (phraseIdx >= 0 ? Math.min(phraseIdx, 200) : 200) * 0.5;
        out.push({ video: v, score, kind: "description" });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, MAX_RESULTS);
  }, [query, videos]);

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
          onPick(hit.video);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, results, activeIdx, onClose, onPick]);

  // Keep the active row in view as the user arrow-keys through results.
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
        className="w-[640px] max-w-[92vw] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library by title, uploader, tag, or description…"
            className="flex-1 text-[14px] bg-transparent outline-none placeholder:text-[var(--color-ink-faint)]"
          />
          <span className="text-[11px] text-[var(--color-ink-faint)] hidden md:inline">
            ↑↓ navigate · ↵ open · esc close
          </span>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
          {query.trim() === "" ? (
            <EmptyHint videos={videos} />
          ) : results.length === 0 ? (
            <div className="px-5 py-8 text-center text-[12.5px] text-[var(--color-ink-dim)]">
              Nothing matches “{query.trim()}”
            </div>
          ) : (
            results.map((r, i) => (
              <ResultRow
                key={r.video.id}
                result={r}
                idx={i}
                query={query.trim()}
                active={i === activeIdx}
                onHover={() => setActiveIdx(i)}
                onPick={() => {
                  onPick(r.video);
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

function EmptyHint({ videos }: { videos: Video[] }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-[var(--color-ink-dim)]">
      {videos.length === 0
        ? "Your library is empty"
        : `Type to search across ${videos.length} ${videos.length === 1 ? "video" : "videos"} — titles ranked first, descriptions next.`}
    </div>
  );
}

function ResultRow({
  result,
  idx,
  query,
  active,
  onHover,
  onPick,
}: {
  result: Result;
  idx: number;
  query: string;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const v = result.video;
  const dur = formatDuration(v.duration);
  const sourceLabel: Record<Result["kind"], string> = {
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
          ? "bg-[var(--color-surface-2)] border-[var(--color-accent)]"
          : "border-transparent hover:bg-[var(--color-surface-2)]/60")
      }
    >
      <div className="relative shrink-0 w-[88px] h-[50px] rounded overflow-hidden bg-[var(--color-canvas)]">
        {v.thumbnail_url ? (
          <img
            src={v.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            className={"w-full h-full object-cover " + (v.watched ? "opacity-50" : "")}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--color-ink-faint)] text-[10px]">
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
          <Highlight text={v.title} query={query} />
        </div>
        <div className="mt-0.5 text-[11.5px] text-[var(--color-ink-dim)] truncate flex items-center gap-1.5">
          {v.uploader && (
            <>
              <span>{v.uploader}</span>
              <span className="text-[var(--color-ink-faint)]">·</span>
            </>
          )}
          {v.upload_date && (
            <>
              <span className="text-[var(--color-ink-faint)]">
                {formatUploadDate(v.upload_date, "short")}
              </span>
              <span className="text-[var(--color-ink-faint)]">·</span>
            </>
          )}
          <span className="text-[10.5px] uppercase tracking-wider text-[var(--color-accent)]/85">
            {sourceLabel[result.kind]}
          </span>
        </div>
        {result.kind === "description" && v.description && (
          <div className="mt-1 text-[11.5px] text-[var(--color-ink-faint)] line-clamp-1">
            <Highlight text={excerptAround(v.description, query)} query={query} />
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
        className="bg-[var(--color-accent)]/25 text-[var(--color-ink)] rounded px-[1px]"
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
      className="text-[var(--color-ink-faint)]"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
