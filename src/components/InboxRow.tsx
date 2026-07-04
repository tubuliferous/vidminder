import type { ChannelVideo } from "../types";
import {
  formatDuration,
  formatUploadDate,
  INBOX_DRAG_MIME,
  recencyBucket,
} from "../utils";
import { cachedRowDragImage, ensureRowDragImage } from "../dragImage";
import * as api from "../api";

type Props = {
  cv: ChannelVideo;
  busy: boolean;
  showChannelName?: boolean;
  /// When set, single-clicking the row selects it (showing its details in the
  /// right sidebar). `selected` drives the highlight. Optional so the global
  /// inbox view — which has no details panel — can omit it.
  selected?: boolean;
  onSelect?: () => void;
  onAdd: () => void;
  onDismiss: () => void;
  onOpen: () => void;
  onDragStateChange?: (dragging: boolean) => void;
};

export function InboxRow({
  cv,
  busy,
  showChannelName = true,
  selected = false,
  onSelect,
  onAdd,
  onDismiss,
  onOpen,
  onDragStateChange,
}: Props) {
  const dur = formatDuration(cv.duration);
  const isUnseen = cv.seen_at == null;
  const isFresh =
    recencyBucket(cv.upload_date, cv.first_seen_at, cv.upload_timestamp) !==
    "older";
  // Only items that are both recent and unviewed contribute to the inbox count
  // badge, so that's the same filter for the NEW pill. Already-added videos
  // carry the "In list" badge instead, so they never show "New".
  const showNewBadge = isUnseen && isFresh && !cv.in_library;
  const dragKey = `cv${cv.id}`;
  const dragLook = {
    title: cv.title,
    subtitle: cv.channel_name,
    thumbnailUrl: cv.thumbnail_url,
  };
  return (
    <div
      draggable
      onMouseDown={() => {
        // Clear any stray selection BEFORE WebKit builds the drag store (it
        // decides what's being dragged at mousedown, before dragstart fires).
        window.getSelection()?.removeAllRanges();
      }}
      onMouseEnter={() => {
        // Pre-render the drag image so it's ready synchronously at dragstart.
        ensureRowDragImage(dragKey, dragLook);
      }}
      onDragStart={(e) => {
        // A stray text selection makes WebKit composite the entire selection
        // into the drag snapshot (a ghost of other rows' text). Clear it and
        // use our pre-rendered row card — same look as every other row drag.
        window.getSelection()?.removeAllRanges();
        const cached = cachedRowDragImage(dragKey);
        if (cached) {
          e.dataTransfer.setDragImage(cached.img, 24, 38);
        } else {
          const rect = e.currentTarget.getBoundingClientRect();
          e.dataTransfer.setDragImage(
            e.currentTarget,
            e.clientX - rect.left,
            e.clientY - rect.top
          );
        }
        // Carry the watch URL so dropping onto a tag folder (or anywhere in the
        // window) adds the video to the library — the sidebar's URL-drop path
        // and the global drop-to-add handler both read it. The marker MIME
        // tells the global handler this is a row drag (allow the drop, but
        // don't show the external-URL overlay).
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(INBOX_DRAG_MIME, "1");
        e.dataTransfer.setData("text/uri-list", cv.url);
        e.dataTransfer.setData("text/plain", cv.url);
        onDragStateChange?.(true);
      }}
      onDragEnd={() => onDragStateChange?.(false)}
      onClick={onSelect}
      onDoubleClick={onOpen}
      title="Click for details · double-click anywhere to play in browser · drag onto a tag to add it there"
      className={
        "flex gap-3 p-2.5 rounded-md border transition group cursor-pointer select-none " +
        (selected
          ? "bg-surface-2 border-accent ring-1 ring-accent"
          : cv.in_library
          ? "bg-surface/40 border-line/40 border-l-2 border-l-accent/60 hover:border-line-soft"
          : showNewBadge
          ? "bg-surface border-line hover:border-line-soft"
          : "bg-surface/60 border-line/50 hover:border-line-soft")
      }
    >
      <div
        className="relative shrink-0 w-[156px] h-[88px] rounded overflow-hidden bg-surface-2"
      >
        {cv.in_library ? (
          <span className="absolute top-1 left-1 text-[9px] font-bold tracking-[0.06em] uppercase px-1.5 py-[1px] rounded bg-accent/90 text-black shadow-sm inline-flex items-center gap-0.5">
            <span aria-hidden>✓</span> In list
          </span>
        ) : showNewBadge ? (
          <span className="absolute top-1 left-1 text-[9px] font-bold tracking-[0.08em] uppercase px-1.5 py-[1px] rounded bg-accent text-black shadow-sm">
            New
          </span>
        ) : null}
        {cv.thumbnail_url ? (
          <img
            src={cv.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
            // Without this, grabbing the thumbnail starts a native *image* drag
            // (WKWebView), which overwrites text/uri-list with the thumbnail URL
            // — so the row's watch-URL payload is lost and the drop is rejected.
            draggable={false}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-faint text-xs">
            no preview
          </div>
        )}
        {dur && (
          <span className="absolute bottom-1 right-1 bg-black/75 text-white text-[10px] px-1.5 py-0.5 rounded">
            {dur}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div
          className={
            "text-[13.5px] leading-snug line-clamp-2 " +
            (isUnseen ? "font-semibold" : "font-normal text-ink-dim")
          }
        >
          {cv.title}
        </div>
        <div className="mt-1 text-[11.5px] text-ink-dim truncate">
          {showChannelName && (
            <>
              <button
                onClick={() => api.openInBrowser(cv.channel_url)}
                className="text-ink-dim hover:text-accent hover:underline transition-colors"
                title={`Open ${cv.channel_name} on YouTube`}
              >
                {cv.channel_name}
              </button>
              <span className="mx-1.5 text-ink-faint">·</span>
            </>
          )}
          <span className="text-ink-faint">
            {formatUploadDate(cv.upload_date, "short", cv.upload_timestamp) ||
              "Unknown date"}
          </span>
        </div>
        <div
          className="mt-auto pt-2 flex items-center gap-2"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {cv.in_library ? (
            <span className="text-[12px] px-2.5 py-1 rounded-md inline-flex items-center gap-1 text-accent font-medium">
              <span aria-hidden>✓</span> In your list
            </span>
          ) : (
            <>
              <button
                onClick={onAdd}
                disabled={busy}
                className="text-[12px] px-2.5 py-1 rounded-md bg-accent text-black hover:brightness-110 disabled:opacity-50 transition"
              >
                {busy ? "Adding…" : "+ Add to list"}
              </button>
              <button
                onClick={onDismiss}
                disabled={busy}
                className="text-[12px] px-2.5 py-1 rounded-md border border-line text-ink-dim hover:text-ink hover:bg-surface-2 disabled:opacity-50 transition"
              >
                Dismiss
              </button>
            </>
          )}
          <button
            onClick={onOpen}
            className="text-[11.5px] text-ink-faint hover:text-ink-dim ml-1 transition"
          >
            play in browser
          </button>
        </div>
      </div>
    </div>
  );
}
