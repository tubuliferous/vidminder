import { useRef, useState } from "react";
import type { Channel, Filter, Video } from "../types";
import { DRAG_MIME } from "../utils";
import * as api from "../api";

type Props = {
  videos: Video[];
  channels: Channel[];
  inboxCount: number;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onFollowClick: () => void;
  draggingVideo: boolean;
  onDropToFolder: (videoId: number, folder: string) => void;
  onDropToTag: (videoId: number, tag: string) => void;
  onDropToFavorites: (videoId: number) => void;
  onDropToWatched: (videoId: number) => void;
  onDropToUnwatched: (videoId: number) => void;
  onChannelCategoryChange: (channelId: number, category: string | null) => void;
  onOpenSettings: () => void;
};

function counts(videos: Video[]) {
  const tags = new Map<string, number>();
  const folders = new Map<string, number>();
  const categories = new Map<string, number>();
  const sources = new Map<string, number>();
  let watched = 0;
  let favorites = 0;
  for (const v of videos) {
    if (v.watched) watched += 1;
    if (v.favorite) favorites += 1;
    for (const t of v.user_tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    if (v.folder) folders.set(v.folder, (folders.get(v.folder) ?? 0) + 1);
    if (v.category) categories.set(v.category, (categories.get(v.category) ?? 0) + 1);
    if (v.source) sources.set(v.source, (sources.get(v.source) ?? 0) + 1);
  }
  return { tags, folders, categories, sources, watched, favorites };
}

function sortByCount(m: Map<string, number>) {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const SECTION_STATE_KEY = "vidminder.sidebar.sections.v1";

function loadSectionExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_STATE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

function saveSectionExpanded(state: Record<string, boolean>) {
  try {
    localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage can fail in private browsing — ignore */
  }
}

function useCollapsibleSection(key: string, defaultExpanded = true): [boolean, () => void] {
  const [expanded, setExpanded] = useState(() => {
    const state = loadSectionExpanded();
    return state[key] ?? defaultExpanded;
  });
  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      const state = loadSectionExpanded();
      state[key] = next;
      saveSectionExpanded(state);
      return next;
    });
  };
  return [expanded, toggle];
}

function Section({
  title,
  trailing,
  collapsible = true,
  storageKey,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  collapsible?: boolean;
  storageKey?: string;
  children: React.ReactNode;
}) {
  const [expanded, toggle] = useCollapsibleSection(storageKey ?? title, true);
  const showContent = !collapsible || expanded;
  return (
    <div className="mb-5">
      <div className="px-3 mb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)]">
        {collapsible ? (
          <button
            onClick={toggle}
            className="flex items-center gap-1 hover:text-[var(--color-ink-dim)] transition group"
            title={expanded ? "Collapse" : "Expand"}
          >
            <Chevron expanded={expanded} />
            <span>{title}</span>
          </button>
        ) : (
          <span>{title}</span>
        )}
        {trailing}
      </div>
      {showContent && <div className="flex flex-col">{children}</div>}
    </div>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"transition-transform " + (expanded ? "rotate-90" : "")}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

type RowProps = {
  active: boolean;
  label: string;
  count?: number;
  badge?: number;
  onClick: () => void;
  dropTarget?: boolean;
  draggingVideo?: boolean;
  onDropVideo?: (videoId: number) => void;
};

function Row({
  active,
  label,
  count,
  badge,
  onClick,
  dropTarget,
  draggingVideo,
  onDropVideo,
}: RowProps) {
  const [hover, setHover] = useState(false);
  // Counter-based drag tracking — DOM dragenter/dragleave fire on every child
  // boundary, which makes naive hover-state flicker. Increment on enter,
  // decrement on leave, only flip hover when the count hits zero.
  const dragDepth = useRef(0);
  const drag = !!dropTarget && draggingVideo;

  const carriesVideo = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types || []).includes(DRAG_MIME);

  return (
    <button
      onClick={onClick}
      onDragEnter={
        drag
          ? (e) => {
              if (!carriesVideo(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              dragDepth.current += 1;
              if (dragDepth.current === 1) setHover(true);
            }
          : undefined
      }
      onDragOver={
        drag
          ? (e) => {
              if (!carriesVideo(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          : undefined
      }
      onDragLeave={
        drag
          ? () => {
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (dragDepth.current === 0) setHover(false);
            }
          : undefined
      }
      onDrop={
        drag
          ? (e) => {
              const id = e.dataTransfer.getData(DRAG_MIME);
              dragDepth.current = 0;
              setHover(false);
              if (!id) return;
              e.preventDefault();
              onDropVideo?.(+id);
            }
          : undefined
      }
      className={
        "group flex items-center justify-between text-left text-[13px] rounded-md mx-1.5 px-2 py-[5px] transition-colors " +
        (hover
          ? "bg-[var(--color-accent)] text-black ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-surface)]"
          : active
          ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
          : drag
          ? "text-[var(--color-ink-dim)] bg-[var(--color-surface-2)]/40 outline-dashed outline-2 outline-[var(--color-accent)]/55 outline-offset-[-3px]"
          : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]")
      }
    >
      {/* pointer-events-none on children so dragenter/leave only fire on the
          button itself — without it, moving across nested spans counted as
          enter/leave events and made the hover state flicker. */}
      <span className="pointer-events-none truncate flex-1">{label}</span>
      <span className="pointer-events-none flex items-center gap-1.5">
        {badge != null && badge > 0 && (
          <span
            className={
              "text-[10px] tabular-nums px-1.5 py-[1px] rounded-full font-semibold " +
              (hover ? "bg-black/20 text-black" : "bg-[var(--color-accent)] text-black")
            }
          >
            {badge}
          </span>
        )}
        {count != null && (
          <span
            className={
              "text-[11px] tabular-nums " +
              (hover
                ? "text-black/70"
                : active
                ? "text-[var(--color-ink-dim)]"
                : "text-[var(--color-ink-faint)]")
            }
          >
            {count}
          </span>
        )}
      </span>
    </button>
  );
}

export function Sidebar({
  videos,
  channels,
  inboxCount,
  filter,
  onFilter,
  onRefresh,
  refreshing,
  onFollowClick,
  draggingVideo,
  onDropToFolder,
  onDropToTag,
  onDropToFavorites,
  onDropToWatched,
  onDropToUnwatched,
  onChannelCategoryChange,
  onOpenSettings,
}: Props) {
  const c = counts(videos);
  const total = videos.length;
  const unwatched = total - c.watched;
  const isActive = (f: Filter) => JSON.stringify(f) === JSON.stringify(filter);

  return (
    <aside className="w-[228px] shrink-0 h-full flex flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="flex-1 overflow-y-auto py-4">
        <div className="px-4 mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[var(--color-accent)]" />
          <span className="text-[15px] font-semibold tracking-tight">VidMinder</span>
        </div>

        <Section title="Inbox" storageKey="inbox">
          <Row
            active={isActive({ kind: "inbox" })}
            label="New from channels"
            badge={inboxCount}
            onClick={() => onFilter({ kind: "inbox" })}
          />
        </Section>

        {/* Library stays pinned-open — it's the primary nav and we never want
            users to lose access to "All videos" / Favorites / Watched. */}
        <Section title="Library" collapsible={false}>
          <Row
            active={isActive({ kind: "all" })}
            label="All videos"
            count={total}
            onClick={() => onFilter({ kind: "all" })}
          />
          <Row
            active={isActive({ kind: "favorites" })}
            label="★ Favorites"
            count={c.favorites}
            onClick={() => onFilter({ kind: "favorites" })}
            dropTarget
            draggingVideo={draggingVideo}
            onDropVideo={onDropToFavorites}
          />
          <Row
            active={isActive({ kind: "unwatched" })}
            label="Unwatched"
            count={unwatched}
            onClick={() => onFilter({ kind: "unwatched" })}
            dropTarget
            draggingVideo={draggingVideo}
            onDropVideo={onDropToUnwatched}
          />
          <Row
            active={isActive({ kind: "watched" })}
            label="Watched"
            count={c.watched}
            onClick={() => onFilter({ kind: "watched" })}
            dropTarget
            draggingVideo={draggingVideo}
            onDropVideo={onDropToWatched}
          />
        </Section>

        <Section
          title="Channels"
          storageKey="channels"
          trailing={
            <span className="flex items-center gap-1.5">
              <button
                onClick={onRefresh}
                disabled={refreshing || channels.length === 0}
                className={
                  "text-[10px] uppercase tracking-wider transition-colors min-w-[42px] text-right " +
                  (refreshing
                    ? "text-[var(--color-accent)] cursor-default"
                    : channels.length === 0
                    ? "text-[var(--color-ink-faint)]/40 cursor-not-allowed"
                    : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]")
                }
                title="Check followed channels for new videos"
              >
                {refreshing ? "checking" : "refresh"}
              </button>
              <button
                onClick={onFollowClick}
                className="w-[18px] h-[18px] p-0 rounded-full bg-[var(--color-surface-2)] text-[var(--color-ink-dim)] hover:bg-[var(--color-accent)] hover:text-black transition inline-flex items-center justify-center shrink-0"
                title="Follow a channel"
              >
                <PlusIcon />
              </button>
            </span>
          }
        >
          {channels.length === 0 ? (
            <div className="px-3 text-[11.5px] text-[var(--color-ink-faint)] leading-snug">
              Click <span className="text-[var(--color-ink-dim)]">+</span> to follow a channel by URL, or use “Follow this channel” on any video.
            </div>
          ) : (
            <ChannelList
              channels={channels}
              isActive={isActive}
              onFilter={onFilter}
              onCategoryChange={onChannelCategoryChange}
            />
          )}
        </Section>

        {c.folders.size > 0 && (
          <Section title="Folders" storageKey="folders">
            {sortByCount(c.folders).map(([name, n]) => (
              <Row
                key={"f:" + name}
                active={isActive({ kind: "folder", name })}
                label={name}
                count={n}
                onClick={() => onFilter({ kind: "folder", name })}
                dropTarget
                draggingVideo={draggingVideo}
                onDropVideo={(id) => onDropToFolder(id, name)}
              />
            ))}
          </Section>
        )}

        {c.tags.size > 0 && (
          <Section title="Tags" storageKey="tags">
            {sortByCount(c.tags).map(([name, n]) => (
              <Row
                key={"t:" + name}
                active={isActive({ kind: "tag", name })}
                label={name}
                count={n}
                onClick={() => onFilter({ kind: "tag", name })}
                dropTarget
                draggingVideo={draggingVideo}
                onDropVideo={(id) => onDropToTag(id, name)}
              />
            ))}
          </Section>
        )}

        {c.categories.size > 0 && (
          <Section title="Categories" storageKey="categories">
            {sortByCount(c.categories).map(([name, n]) => (
              <Row
                key={"c:" + name}
                active={isActive({ kind: "category", name })}
                label={name}
                count={n}
                onClick={() => onFilter({ kind: "category", name })}
              />
            ))}
          </Section>
        )}

        {c.sources.size > 1 && (
          <Section title="Sources" storageKey="sources">
            {sortByCount(c.sources).map(([name, n]) => (
              <Row
                key={"s:" + name}
                active={isActive({ kind: "source", name })}
                label={name}
                count={n}
                onClick={() => onFilter({ kind: "source", name })}
              />
            ))}
          </Section>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--color-line)] px-3 py-2 flex items-center justify-between">
        <span className="text-[10.5px] text-[var(--color-ink-faint)]">
          ⌘, to open settings
        </span>
        <button
          onClick={onOpenSettings}
          title="Settings (⌘,)"
          className="w-7 h-7 rounded-md text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-2)] transition flex items-center justify-center"
        >
          <GearIcon />
        </button>
      </div>
    </aside>
  );
}

/// Groups channels by their `category` field. If everyone is uncategorized
/// (the default state for a fresh install), renders flat. Otherwise groups by
/// category with collapsible sub-sections; uncategorized channels land in an
/// "Uncategorized" group at the bottom.
function ChannelList({
  channels,
  isActive,
  onFilter,
  onCategoryChange,
}: {
  channels: Channel[];
  isActive: (f: Filter) => boolean;
  onFilter: (f: Filter) => void;
  onCategoryChange: (channelId: number, category: string | null) => void;
}) {
  const allUncategorized = channels.every((c) => !c.category);
  if (allUncategorized) {
    return (
      <>
        {channels.map((ch) => (
          <ChannelRow
            key={ch.id}
            channel={ch}
            active={isActive({ kind: "channel", channelId: ch.id })}
            onSelect={() => onFilter({ kind: "channel", channelId: ch.id })}
            onCategoryChange={onCategoryChange}
          />
        ))}
      </>
    );
  }

  const grouped = new Map<string, Channel[]>();
  for (const ch of channels) {
    const key = ch.category && ch.category.trim() ? ch.category.trim() : "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(ch);
  }
  const entries = [...grouped.entries()].sort((a, b) => {
    // Uncategorized last; otherwise alphabetical.
    if (a[0] === "" && b[0] !== "") return 1;
    if (b[0] === "" && a[0] !== "") return -1;
    return a[0].localeCompare(b[0]);
  });

  return (
    <>
      {entries.map(([cat, chs]) => (
        <CategoryGroup
          key={cat || "__uncat__"}
          title={cat || "Uncategorized"}
          storageKey={"channel-category-" + (cat || "__uncat__")}
        >
          {chs.map((ch) => (
            <ChannelRow
              key={ch.id}
              channel={ch}
              active={isActive({ kind: "channel", channelId: ch.id })}
              onSelect={() => onFilter({ kind: "channel", channelId: ch.id })}
              onCategoryChange={onCategoryChange}
            />
          ))}
        </CategoryGroup>
      ))}
    </>
  );
}

function CategoryGroup({
  title,
  storageKey,
  children,
}: {
  title: string;
  storageKey: string;
  children: React.ReactNode;
}) {
  const [expanded, toggle] = useCollapsibleSection(storageKey, true);
  return (
    <div className="mt-1">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1 text-left text-[11.5px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)] mx-1.5 px-2 py-[3px] rounded transition-colors group"
      >
        <Chevron expanded={expanded} />
        <span className="font-medium tracking-tight">{title}</span>
      </button>
      {expanded && <div className="flex flex-col">{children}</div>}
    </div>
  );
}

function ChannelRow({
  channel,
  active,
  onSelect,
  onCategoryChange,
}: {
  channel: Channel;
  active: boolean;
  onSelect: () => void;
  onCategoryChange: (channelId: number, category: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(channel.category ?? "");
  const beginEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(channel.category ?? "");
    setEditing(true);
  };
  const commit = () => {
    const next = draft.trim() || null;
    if (next !== (channel.category ?? null)) {
      onCategoryChange(channel.id, next);
    }
    setEditing(false);
  };
  const cancel = () => {
    setDraft(channel.category ?? "");
    setEditing(false);
  };
  const openOnYouTube = (e: React.MouseEvent) => {
    e.stopPropagation();
    api.openInBrowser(channel.url);
  };

  if (editing) {
    return (
      <div className="mx-1.5 px-2 py-[5px] flex items-center gap-1.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") cancel();
          }}
          onBlur={commit}
          placeholder={`Category for ${channel.name}`}
          className="flex-1 text-[12.5px] px-2 py-[2px] rounded bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={
        "group flex items-center justify-between text-left text-[13px] rounded-md mx-1.5 px-2 py-[5px] transition-colors cursor-pointer " +
        (active
          ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
          : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]")
      }
    >
      <span className="truncate flex-1">{channel.name}</span>
      <span className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={beginEdit}
          title={
            channel.category
              ? `Category: ${channel.category} — click to edit`
              : "Set a category"
          }
          className="opacity-0 group-hover:opacity-100 text-[var(--color-ink-faint)] hover:text-[var(--color-accent)] transition"
        >
          <TagIcon />
        </button>
        <button
          onClick={openOnYouTube}
          title={`Open ${channel.name} on YouTube`}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-ink-faint)] hover:text-[var(--color-accent)] transition"
        >
          <ExternalLinkIcon />
        </button>
        {channel.inbox_count > 0 && (
          <span className="text-[10px] tabular-nums px-1.5 py-[1px] rounded-full bg-[var(--color-accent)] text-black font-semibold">
            {channel.inbox_count}
          </span>
        )}
      </span>
    </div>
  );
}

function TagIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function PlusIcon() {
  // Filled-rect plus instead of stroked lines — avoids subpixel rounding
  // mismatches between vertical and horizontal arms that can make a stroked
  // SVG look visually off-center inside a small flex container.
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="currentColor"
      className="block"
      shapeRendering="crispEdges"
    >
      <rect x="4" y="0" width="2" height="10" />
      <rect x="0" y="4" width="10" height="2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
