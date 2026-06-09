import { useEffect, useMemo, useRef, useState } from "react";
import type { Channel, Filter, TagCount, Video } from "../types";
import { DRAG_MIME, extractUrlFromDrop } from "../utils";
import { kbd } from "../platform";
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
  onDropToTag: (videoId: number, tag: string) => void;
  onDropUrlToTag: (url: string, tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => void;
  onDeleteTag: (tag: string) => void;
  onDropToFavorites: (videoId: number) => void;
  onDropToWatched: (videoId: number) => void;
  onDropToUnwatched: (videoId: number) => void;
  onChannelCategoryChange: (channelId: number, category: string | null) => void;
  onOpenSettings: () => void;
};

function counts(videos: Video[]) {
  const tagCounts = new Map<string, number>();
  const categories = new Map<string, number>();
  let watched = 0;
  let favorites = 0;
  let downloaded = 0;
  for (const v of videos) {
    if (v.watched) watched += 1;
    if (v.favorite) favorites += 1;
    if (v.offline_status === "ready") downloaded += 1;
    for (const t of v.user_tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    if (v.category) categories.set(v.category, (categories.get(v.category) ?? 0) + 1);
  }
  const tags: TagCount[] = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
  return { tags, categories, watched, favorites, downloaded };
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
      <div className="px-3 mb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-[0.12em] uppercase text-ink-faint">
        {collapsible ? (
          <button
            onClick={toggle}
            className="flex items-center gap-1 hover:text-ink-dim transition group"
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
  icon?: React.ReactNode;
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
  icon,
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
          ? "bg-accent text-black ring-2 ring-accent ring-offset-2 ring-offset-surface"
          : active
          ? "bg-accent-dim text-ink"
          : drag
          ? "text-ink-dim bg-surface-2/40 outline-dashed outline-2 outline-accent/55 outline-offset-[-3px]"
          : "text-ink-dim hover:bg-surface-2 hover:text-ink")
      }
    >
      {/* pointer-events-none on children so dragenter/leave only fire on the
          button itself — without it, moving across nested spans counted as
          enter/leave events and made the hover state flicker. */}
      <span className="pointer-events-none truncate flex-1 flex items-center gap-1.5">
        {icon != null && (
          <span className="shrink-0 text-ink-faint">{icon}</span>
        )}
        <span className="truncate">{label}</span>
      </span>
      <span className="pointer-events-none flex items-center gap-1.5">
        {badge != null && badge > 0 && (
          <span
            className={
              "text-[10px] tabular-nums px-1.5 py-[1px] rounded-full font-semibold " +
              (hover ? "bg-black/20 text-black" : "bg-accent text-black")
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
                ? "text-ink-dim"
                : "text-ink-faint")
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
  onDropToTag,
  onDropUrlToTag,
  onRenameTag,
  onDeleteTag,
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
    <aside className="w-[228px] shrink-0 h-full flex flex-col border-r border-line bg-surface">
      <div className="flex-1 overflow-y-auto py-4">
        <div className="px-4 mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-accent" />
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
            icon={<EyeOffIcon />}
            count={unwatched}
            onClick={() => onFilter({ kind: "unwatched" })}
            dropTarget
            draggingVideo={draggingVideo}
            onDropVideo={onDropToUnwatched}
          />
          <Row
            active={isActive({ kind: "watched" })}
            label="Watched"
            icon={<EyeIcon />}
            count={c.watched}
            onClick={() => onFilter({ kind: "watched" })}
            dropTarget
            draggingVideo={draggingVideo}
            onDropVideo={onDropToWatched}
          />
          <Row
            active={isActive({ kind: "downloaded" })}
            label="⤓ Downloaded"
            count={c.downloaded}
            onClick={() => onFilter({ kind: "downloaded" })}
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
                    ? "text-accent cursor-default"
                    : channels.length === 0
                    ? "text-ink-faint/40 cursor-not-allowed"
                    : "text-ink-faint hover:text-ink")
                }
                title="Check followed channels for new videos"
              >
                {refreshing ? "checking" : "refresh"}
              </button>
              <button
                onClick={onFollowClick}
                className="w-[14px] h-[14px] p-0 rounded-full bg-surface-2 text-ink-dim hover:bg-accent hover:text-black transition inline-flex items-center justify-center shrink-0"
                title="Follow a channel"
              >
                <PlusIcon />
              </button>
            </span>
          }
        >
          {channels.length === 0 ? (
            <div className="px-3 text-[11.5px] text-ink-faint leading-snug">
              Click <span className="text-ink-dim">+</span> to follow a channel by URL, or use “Follow this channel” on any video.
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

        {c.tags.length > 0 && (
          <Section title="Tags" storageKey="tags">
            <TagTree
              tags={c.tags}
              filter={filter}
              onFilter={onFilter}
              draggingVideo={draggingVideo}
              onDropToTag={onDropToTag}
              onDropUrlToTag={onDropUrlToTag}
              onRenameTag={onRenameTag}
              onDeleteTag={onDeleteTag}
            />
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
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2 flex items-center justify-between">
        <span className="text-[10.5px] text-ink-faint">
          {kbd(",")} to open settings
        </span>
        <button
          onClick={onOpenSettings}
          title={`Settings (${kbd(",")})`}
          className="w-7 h-7 rounded-md text-ink-faint hover:text-ink hover:bg-surface-2 transition flex items-center justify-center"
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
        className="w-full flex items-center gap-1 text-left text-[11.5px] text-ink-faint hover:text-ink-dim mx-1.5 px-2 py-[3px] rounded transition-colors group"
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
          className="flex-1 text-[12.5px] px-2 py-[2px] rounded bg-canvas border border-line focus:outline-none focus:border-accent"
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
          ? "bg-accent-dim text-ink"
          : "text-ink-dim hover:bg-surface-2 hover:text-ink")
      }
    >
      <span className="flex items-center gap-2 min-w-0 flex-1">
        <ChannelAvatar url={channel.thumbnail_url} name={channel.name} />
        <span className="truncate">{channel.name}</span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={beginEdit}
          title={
            channel.category
              ? `Category: ${channel.category} — click to edit`
              : "Set a category"
          }
          className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-accent transition"
        >
          <TagIcon />
        </button>
        <button
          onClick={openOnYouTube}
          title={`Open ${channel.name} on YouTube`}
          className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-accent transition"
        >
          <ExternalLinkIcon />
        </button>
        {channel.inbox_count > 0 && (
          <span className="text-[10px] tabular-nums px-1.5 py-[1px] rounded-full bg-accent text-black font-semibold">
            {channel.inbox_count}
          </span>
        )}
      </span>
    </div>
  );
}

/// Small round channel avatar shown left of the name. Falls back to the first
/// letter on a tinted circle when there's no image or it fails to load.
function ChannelAvatar({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className="w-4 h-4 rounded-full object-cover shrink-0 bg-surface-2"
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="w-4 h-4 rounded-full shrink-0 bg-surface-2 text-ink-faint text-[9px] font-semibold flex items-center justify-center">
      {initial}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dotted-tag tree (Calibre-style). Tags are stored flat as dotted strings on
// the backend; the tree is derived here at render time. Selecting a node
// filters inclusively — clicking "science" lists videos tagged "science",
// "science.biology", "science.biology.computational", etc. (the App.tsx tag
// filter implements the same prefix rule).
// ---------------------------------------------------------------------------

type TagNode = {
  name: string; // last dotted segment, what the row renders
  path: string; // full dotted path
  children: TagNode[];
  exact: number; // videos tagged exactly this path
  total: number; // inclusive: exact + sum of descendants' exact
};

function buildTagTree(tags: TagCount[]): TagNode[] {
  const root: TagNode = { name: "", path: "", children: [], exact: 0, total: 0 };
  const find = (parent: TagNode, name: string, path: string): TagNode => {
    let child = parent.children.find((c) => c.name === name);
    if (!child) {
      child = { name, path, children: [], exact: 0, total: 0 };
      parent.children.push(child);
    }
    return child;
  };
  for (const { tag, count } of tags) {
    const segs = tag.split(".").filter(Boolean);
    if (!segs.length) continue;
    let node = root;
    let acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}.${seg}` : seg;
      node = find(node, seg, acc);
    }
    node.exact += count;
  }
  const fill = (n: TagNode): number => {
    n.total = n.exact + n.children.reduce((s, c) => s + fill(c), 0);
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    return n.total;
  };
  root.children.forEach(fill);
  root.children.sort((a, b) => a.name.localeCompare(b.name));
  return root.children;
}

const TAG_COLLAPSED_KEY = "vidminder.sidebar.tag-collapsed.v1";

function loadTagCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(TAG_COLLAPSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function saveTagCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(TAG_COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* private browsing — ignore */
  }
}

function TagTree({
  tags,
  filter,
  onFilter,
  draggingVideo,
  onDropToTag,
  onDropUrlToTag,
  onRenameTag,
  onDeleteTag,
}: {
  tags: TagCount[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  draggingVideo: boolean;
  onDropToTag: (videoId: number, tag: string) => void;
  onDropUrlToTag: (url: string, tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => void;
  onDeleteTag: (tag: string) => void;
}) {
  const tree = useMemo(() => buildTagTree(tags), [tags]);
  // Default expanded; track only the paths the user has explicitly collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadTagCollapsed());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveTagCollapsed(next);
      return next;
    });
  };

  // ⌥-click: collapse or expand a node AND all its descendants in one shot.
  const toggleSubtree = (node: TagNode, open: boolean) => {
    const paths: string[] = [];
    const walk = (n: TagNode) => {
      paths.push(n.path);
      n.children.forEach(walk);
    };
    walk(node);
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (open) next.delete(p);
        else next.add(p);
      }
      saveTagCollapsed(next);
      return next;
    });
  };

  const renderNode = (n: TagNode, depth: number): React.ReactNode => {
    const isOpen = !collapsed.has(n.path);
    const isActiveNode =
      filter.kind === "tag" && (filter as { name: string }).name === n.path;
    const hasKids = n.children.length > 0;
    return (
      <div key={n.path}>
        <TagNodeRow
          node={n}
          depth={depth}
          isOpen={isOpen}
          isActive={isActiveNode}
          isRenaming={renaming === n.path}
          draggingVideo={draggingVideo}
          onClick={(e) => {
            // ⌥-click anywhere on a tag row expands/collapses its whole subtree.
            if (e.altKey && hasKids) toggleSubtree(n, collapsed.has(n.path));
            else onFilter({ kind: "tag", name: n.path });
          }}
          onToggle={(e) => {
            if (e.altKey && hasKids) toggleSubtree(n, collapsed.has(n.path));
            else toggle(n.path);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, path: n.path });
          }}
          onBeginRename={() => setRenaming(n.path)}
          onCommitRename={(seg) => {
            setRenaming(null);
            const clean = seg.trim().replace(/\./g, " ").trim();
            if (!clean || clean === n.name) return;
            const parent = n.path.includes(".")
              ? n.path.slice(0, n.path.lastIndexOf("."))
              : "";
            onRenameTag(n.path, parent ? `${parent}.${clean}` : clean);
          }}
          onCancelRename={() => setRenaming(null)}
          onDropVideo={(vid) => onDropToTag(vid, n.path)}
          onDropUrl={(url) => onDropUrlToTag(url, n.path)}
        />
        {isOpen && hasKids && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <>
      {tree.map((n) => renderNode(n, 0))}
      {menu && (
        <TagContextMenu
          x={menu.x}
          y={menu.y}
          path={menu.path}
          onRename={(path) => {
            setMenu(null);
            setRenaming(path);
          }}
          onDelete={(path) => {
            setMenu(null);
            if (confirm(`Delete tag "${path}" and all its sub-tags from every video?`)) {
              onDeleteTag(path);
            }
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

function TagContextMenu({
  x,
  y,
  path,
  onRename,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  path: string;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onClose: () => void;
}) {
  // Dismiss on any outside click, right-click, or Escape. Binding through
  // useEffect ensures we always tear down on unmount — earlier "addEventListener
  // with { once: true }" was lossy because three listeners could leak past the
  // single click that closed the menu.
  useEffect(() => {
    const close = () => onClose();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", left: x, top: y, zIndex: 1000 }}
      className="min-w-[160px] rounded-md border border-line bg-surface shadow-xl py-1 text-[12.5px]"
    >
      <button
        onClick={() => onRename(path)}
        className="block w-full text-left px-3 py-1.5 text-ink-dim hover:bg-surface-2 hover:text-ink"
      >
        Rename…
      </button>
      <button
        onClick={() => onDelete(path)}
        className="block w-full text-left px-3 py-1.5 text-ink-dim hover:bg-surface-2 hover:text-danger"
      >
        Delete tag + sub-tags
      </button>
    </div>
  );
}

function TagNodeRow({
  node,
  depth,
  isOpen,
  isActive,
  isRenaming,
  draggingVideo,
  onClick,
  onToggle,
  onContextMenu,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onDropVideo,
  onDropUrl,
}: {
  node: TagNode;
  depth: number;
  isOpen: boolean;
  isActive: boolean;
  isRenaming: boolean;
  draggingVideo: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onBeginRename: () => void;
  onCommitRename: (newName: string) => void;
  onCancelRename: () => void;
  onDropVideo: (videoId: number) => void;
  onDropUrl: (url: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(node.name);
  const dragDepth = useRef(0);
  const hasKids = node.children.length > 0;

  const carriesDrop = (e: React.DragEvent) => {
    const t = Array.from(e.dataTransfer.types || []);
    return t.includes(DRAG_MIME) || t.includes("text/uri-list") || t.includes("text/plain");
  };

  if (isRenaming) {
    return (
      <div
        className="mx-1.5 px-2 py-[5px]"
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(draft);
            if (e.key === "Escape") {
              setDraft(node.name);
              onCancelRename();
            }
          }}
          onBlur={() => onCommitRename(draft)}
          onClick={(e) => e.stopPropagation()}
          className="w-full text-[12.5px] px-2 py-[2px] rounded bg-canvas border border-line focus:outline-none focus:border-accent"
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-url-drop-target="true"
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent);
        }
      }}
      onDragEnter={(e) => {
        if (!carriesDrop(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        if (dragDepth.current === 1) setHover(true);
      }}
      onDragOver={(e) => {
        if (!carriesDrop(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setHover(false);
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setHover(false);
        const vid = e.dataTransfer.getData(DRAG_MIME);
        if (vid) {
          e.preventDefault();
          onDropVideo(+vid);
          return;
        }
        const url = extractUrlFromDrop(e);
        if (url) {
          e.preventDefault();
          onDropUrl(url);
        }
      }}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={
        "group flex items-center text-left text-[13px] rounded-md mx-1.5 pr-2 py-[5px] gap-1 transition-colors cursor-pointer " +
        (hover
          ? "bg-accent text-black ring-2 ring-accent ring-offset-2 ring-offset-surface"
          : isActive
          ? "bg-accent-dim text-ink"
          : draggingVideo
          ? "text-ink-dim bg-surface-2/40 outline-dashed outline-2 outline-accent/55 outline-offset-[-3px]"
          : "text-ink-dim hover:bg-surface-2 hover:text-ink")
      }
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle(e);
        }}
        className={
          "shrink-0 inline-flex items-center justify-center w-3 h-3 " +
          (hasKids ? "opacity-100" : "opacity-0 pointer-events-none")
        }
        title={hasKids ? "Click to expand/collapse · ⌥-click for the whole subtree" : undefined}
        tabIndex={-1}
      >
        <Chevron expanded={isOpen} />
      </button>
      <span
        className="truncate flex-1"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(node.name);
          onBeginRename();
        }}
        title="Double-click to rename"
      >
        {node.name}
      </span>
      <span
        className={
          "text-[11px] tabular-nums shrink-0 " +
          (hover ? "text-black/70" : "text-ink-faint")
        }
      >
        {node.total}
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

function EyeIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
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
      width="8"
      height="8"
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
