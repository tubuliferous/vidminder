import type { Video } from "../types";
import {
  formatDuration,
  formatAddedAt,
  formatUploadDate,
  DRAG_MIME,
} from "../utils";
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
}: Props) {
  const duration = formatDuration(video.duration);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData(DRAG_MIME, String(video.id));
        // Also stash title for fallback text drag visuals.
        e.dataTransfer.setData("text/x-vidminder-title", video.title);
        onDragStateChange?.(true);
      }}
      onDragEnd={() => onDragStateChange?.(false)}
      onClick={onSelect}
      onMouseDown={onMouseDownRow}
      onMouseEnter={onMouseEnterRow}
      onDoubleClick={onOpen}
      className={
        "group flex gap-3 px-3 py-2.5 cursor-pointer border-l-2 transition-colors " +
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
        {(video.folder || video.user_tags.length > 0 || video.category) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {video.folder && (
              <span className="text-[10.5px] px-1.5 py-[1px] rounded bg-surface-2 text-ink-dim border border-line">
                {video.folder}
              </span>
            )}
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
