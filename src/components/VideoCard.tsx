import type { Video } from "../types";
import {
  formatDuration,
  formatAddedAt,
  formatUploadDate,
  DRAG_MIME,
} from "../utils";
import { cachedRowDragImage, ensureRowDragImage } from "../dragImage";
import * as api from "../api";

type Props = {
  video: Video;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onMouseDownRow?: (e: React.MouseEvent) => void;
  onMouseEnterRow?: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onDragStateChange?: (dragging: boolean) => void;
  /// Live download percent (0–100) while this video is downloading.
  offlinePercent?: number;
  /// One-click download at the user's default quality.
  onDownloadDefault: () => void;
  /// Stop an in-flight download.
  onCancelDownload: () => void;
  /// Play the already-downloaded file in the system player.
  onPlayOffline: () => void;
  /// Open the right-click resolution menu at the given screen coords.
  onRequestQualityMenu: (x: number, y: number) => void;
  /// Open the card's in-app context menu at the given screen coords.
  onRequestContextMenu: (x: number, y: number) => void;
  /// Start a native OS file drag for a DOWNLOADED video. The whole row drag
  /// becomes the export gesture: drop on the Desktop/Finder to copy the file,
  /// drop on a sidebar tag to organize (the drag also carries the video URL).
  onNativeFileDrag?: () => void;
  /// The user dragged a NOT-downloaded video out of the app window: offer the
  /// save dialog (download first, then export to the chosen location).
  onDragOutExport?: () => void;
  /// Export via a save dialog (click action on the export button). Downloads
  /// first if the video isn't offline yet.
  onExportFile?: () => void;
};

export function VideoCard({
  video,
  selected,
  onSelect,
  onMouseDownRow,
  onMouseEnterRow,
  onOpen,
  onToggleFavorite,
  onDragStateChange,
  offlinePercent,
  onDownloadDefault,
  onCancelDownload,
  onPlayOffline,
  onRequestQualityMenu,
  onRequestContextMenu,
  onNativeFileDrag,
  onDragOutExport,
  onExportFile,
}: Props) {
  const duration = formatDuration(video.duration);
  const dragKey = `v${video.id}`;
  const dragLook = {
    title: video.title,
    subtitle: video.uploader ?? video.source,
    thumbnailUrl: video.thumbnail_url,
  };
  return (
    <div className="relative group">
    <div
      draggable
      onDragStart={(e) => {
        // If a stray text selection exists, WebKit composites the WHOLE
        // selection into the drag snapshot — a ghost of other rows' text
        // floats along with the card. Clear it, and never let WebKit generate
        // the image: use our pre-rendered row card (same look as the native
        // file drag) instead.
        window.getSelection()?.removeAllRanges();
        if (onNativeFileDrag) {
          // Replace the HTML5 drag with a native OS file drag (file promise
          // on macOS — works even before the video is downloaded). Dropping
          // on the Desktop/Finder produces the file; dropping on a sidebar
          // tag still organizes, because the drag also carries the video URL
          // as plain text. App passes this prop only where supported.
          e.preventDefault();
          onNativeFileDrag();
          return;
        }
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
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData(DRAG_MIME, String(video.id));
        // Also stash title for fallback text drag visuals.
        e.dataTransfer.setData("text/x-vidminder-title", video.title);
        onDragStateChange?.(true);
      }}
      onDragEnd={(e) => {
        onDragStateChange?.(false);
        // Dragging a not-yet-downloaded video out of the app window exports
        // it: download to ~/Downloads. (A file can't be deposited at an
        // arbitrary OS drop point because it doesn't exist yet at drop time.)
        if (
          video.offline_status !== "ready" &&
          e.dataTransfer.dropEffect === "none" &&
          onDragOutExport
        ) {
          // dragend's client coords are the release point; outside the
          // viewport means the row was dropped beyond the app window.
          const outside =
            e.clientX < 0 ||
            e.clientY < 0 ||
            e.clientX > window.innerWidth ||
            e.clientY > window.innerHeight;
          if (outside) onDragOutExport();
        }
      }}
      onClick={onSelect}
      onMouseDown={(e) => {
        // Clear any stray selection BEFORE WebKit builds the drag store (it
        // decides what's being dragged at mousedown, before dragstart fires).
        window.getSelection()?.removeAllRanges();
        onMouseDownRow?.(e);
      }}
      onMouseEnter={(e) => {
        // Pre-render the drag image so it's ready synchronously at dragstart.
        ensureRowDragImage(dragKey, dragLook);
        onMouseEnterRow?.(e);
      }}
      onDoubleClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRequestContextMenu(e.clientX, e.clientY);
      }}
      className={
        "flex gap-3 px-3 py-2.5 cursor-pointer border-l-2 transition-colors select-none " +
        (selected
          ? "bg-surface-2 border-accent"
          : "border-transparent hover:bg-surface")
      }
    >
      <div className="relative shrink-0 w-[148px] h-[83px] rounded-md overflow-hidden bg-surface-2">
        {video.thumbnail_url ? (
          <img
            src={video.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
            // Without this, grabbing the thumbnail starts a native *image*
            // drag (WKWebView) with a different ghost, bypassing the row's
            // drag handling entirely. The row, not the image, owns the drag.
            draggable={false}
            className={
              "w-full h-full object-cover " + (video.watched ? "opacity-50" : "")
            }
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-faint text-xs">
            no preview
          </div>
        )}
        {duration && (
          <span className="absolute bottom-1 right-1 bg-black/75 text-white text-[10px] px-1.5 py-0.5 rounded">
            {duration}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          title={video.favorite ? "Remove from favorites" : "Add to favorites"}
          className={
            "absolute top-1 left-1 w-6 h-6 rounded-full flex items-center justify-center transition " +
            (video.favorite
              ? "bg-black/55 text-[#ffd66e] opacity-100"
              : "bg-black/45 text-white/85 opacity-0 group-hover:opacity-100 hover:bg-black/65")
          }
        >
          <StarIcon filled={video.favorite} size={13} />
        </button>
        <DownloadButton
          status={video.offline_status}
          percent={offlinePercent}
          onDownload={onDownloadDefault}
          onCancel={onCancelDownload}
          onPlay={onPlayOffline}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRequestQualityMenu(e.clientX, e.clientY);
          }}
        />
        {video.offline_status === "downloading" && (
          <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/45">
            <div
              className="h-full bg-accent"
              style={{ width: `${Math.round(offlinePercent ?? 0)}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div
          className={
            "text-[14px] font-medium leading-snug line-clamp-2 " +
            (video.watched ? "text-ink-dim" : "text-ink")
          }
        >
          {video.title}
        </div>
        <div className="mt-1 text-[12px] text-ink-dim truncate">
          {video.channel_url && video.uploader ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                api.openInBrowser(video.channel_url!);
              }}
              className="hover:text-accent hover:underline transition-colors"
              title={`Open ${video.uploader} on YouTube`}
            >
              {video.uploader}
            </button>
          ) : (
            <span>{video.uploader || video.source}</span>
          )}
          {video.upload_date && (
            <>
              <span className="mx-1.5 text-ink-faint">·</span>
              <span
                className="text-ink-faint"
                title={`Uploaded ${formatUploadDate(video.upload_date, "full")}`}
              >
                {formatUploadDate(video.upload_date, "short")}
              </span>
            </>
          )}
          <span className="mx-1.5 text-ink-faint">·</span>
          <span
            className="text-ink-faint"
            title={`Added on ${new Date(video.added_at * 1000).toLocaleString()}`}
          >
            added {formatAddedAt(video.added_at)}
          </span>
        </div>
        {(video.user_tags.length > 0 || video.category) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {video.user_tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="text-[10.5px] px-1.5 py-[1px] rounded bg-accent-dim/40 text-accent"
              >
                #{t}
              </span>
            ))}
            {video.category && !video.user_tags.includes(video.category) && (
              <span className="text-[10.5px] text-ink-faint">{video.category}</span>
            )}
          </div>
        )}
      </div>
    </div>
    {onExportFile && (
      // Sits outside the draggable div so it never participates in the row
      // drag. Click = export via a save dialog (downloading first if the
      // video isn't offline yet). Dragging the ROW exports too.
      <button
        title={
          video.offline_status === "ready"
            ? "Export video file… · or drag the row to the Desktop"
            : "Export video file… (downloads first) · or drag the row out of the window"
        }
        className="absolute top-1/2 -translate-y-1/2 right-2 opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-surface-2 transition z-10"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onExportFile();
        }}
      >
        <ExportIcon size={12} />
      </button>
    )}
    </div>
  );
}

function DownloadButton({
  status,
  percent,
  onDownload,
  onCancel,
  onPlay,
  onContextMenu,
}: {
  status: string;
  percent?: number;
  onDownload: () => void;
  onCancel: () => void;
  onPlay: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const title =
    status === "downloading"
      ? `Downloading… ${Math.round(percent ?? 0)}% — click to cancel`
      : status === "ready"
      ? "Downloaded — click to play offline · right-click for options"
      : status === "error"
      ? "Download failed — click to retry · right-click to choose quality"
      : "Download for offline · right-click to choose quality";
  const tone =
    status === "ready"
      ? "bg-black/55 text-[#7ee0a0] opacity-100"
      : status === "downloading"
      ? "bg-black/55 text-white opacity-100"
      : status === "error"
      ? "bg-black/55 text-[#ff9b9b] opacity-100"
      : "bg-black/45 text-white/85 opacity-0 group-hover:opacity-100 hover:bg-black/65";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (status === "downloading") onCancel();
        else if (status === "ready") onPlay();
        else onDownload();
      }}
      onContextMenu={onContextMenu}
      title={title}
      className={
        "absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center transition " +
        tone
      }
    >
      {status === "downloading" ? (
        <ProgressRing percent={percent ?? 0} />
      ) : status === "ready" ? (
        <CheckIcon size={13} />
      ) : (
        <DownloadIcon size={13} />
      )}
    </button>
  );
}

function ProgressRing({ percent }: { percent: number }) {
  const r = 7;
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, percent));
  const offset = circ * (1 - clamped / 100);
  return (
    <svg width={16} height={16} viewBox="0 0 18 18">
      <circle cx="9" cy="9" r={r} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="2" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

function DownloadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ExportIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* box with arrow pointing up-right — standard "export" affordance */}
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function StarIcon({ filled, size = 14 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
