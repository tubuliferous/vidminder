import type { ChannelVideo } from "../types";
import { formatDuration, formatUploadDate, recencyBucket } from "../utils";
import * as api from "../api";

type Props = {
  cv: ChannelVideo;
  busy: boolean;
  showChannelName?: boolean;
  onAdd: () => void;
  onDismiss: () => void;
  onOpen: () => void;
};

export function InboxRow({
  cv,
  busy,
  showChannelName = true,
  onAdd,
  onDismiss,
  onOpen,
}: Props) {
  const dur = formatDuration(cv.duration);
  const isUnseen = cv.seen_at == null;
  const isFresh =
    recencyBucket(cv.upload_date, cv.first_seen_at, cv.upload_timestamp) !==
    "older";
  // Only items that are both recent and unviewed contribute to the inbox count
  // badge, so that's the same filter for the NEW pill.
  const showNewBadge = isUnseen && isFresh;
  return (
    <div
      draggable
      onDragStart={(e) => {
        // Carry the watch URL so dropping onto a tag folder adds the video to
        // the library under that tag (handled by the sidebar's URL-drop path).
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/uri-list", cv.url);
        e.dataTransfer.setData("text/plain", cv.url);
      }}
      onDoubleClick={onOpen}
      title="Double-click anywhere to play in browser · drag onto a tag to add it there"
      className={
        "flex gap-3 p-2.5 rounded-md border transition group cursor-pointer " +
        (showNewBadge
          ? "bg-surface border-line hover:border-line-soft"
          : "bg-surface/60 border-line/50 hover:border-line-soft")
      }
    >
      <div
        className="relative shrink-0 w-[156px] h-[88px] rounded overflow-hidden bg-surface-2"
      >
        {showNewBadge && (
          <span className="absolute top-1 left-1 text-[9px] font-bold tracking-[0.08em] uppercase px-1.5 py-[1px] rounded bg-accent text-black shadow-sm">
            New
          </span>
        )}
        {cv.thumbnail_url ? (
          <img
            src={cv.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
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
