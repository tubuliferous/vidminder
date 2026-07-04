import type { ChannelVideo } from "../types";
import { formatDuration, formatUploadDate } from "../utils";
import * as api from "../api";

type Props = {
  cv: ChannelVideo;
  /// True while an add/dismiss is in flight for this item.
  busy: boolean;
  onAdd: () => void;
  onDismiss: () => void;
  onOpen: () => void;
};

/// Right-sidebar details for a channel-feed video that isn't in the library
/// yet. ChannelVideo carries less than a full library Video (no description,
/// category, or tags), so this is a leaner panel — the info we have, plus the
/// same add / play / dismiss actions the row offers.
export function ChannelVideoDetails({
  cv,
  busy,
  onAdd,
  onDismiss,
  onOpen,
}: Props) {
  return (
    <div className="h-full overflow-y-auto border-l border-line bg-surface flex flex-col">
      <div className="aspect-video w-full bg-black relative shrink-0">
        {cv.thumbnail_url ? (
          <img
            src={cv.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
            draggable={false}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-faint text-sm">
            no preview
          </div>
        )}
        {cv.in_library && (
          <span className="absolute top-2 left-2 text-[10px] font-bold tracking-[0.06em] uppercase px-2 py-[2px] rounded bg-accent/90 text-black shadow-sm inline-flex items-center gap-1">
            <span aria-hidden>✓</span> In list
          </span>
        )}
        {cv.is_short && (
          <span className="absolute top-2 right-2 text-[10px] font-semibold uppercase tracking-[0.06em] px-2 py-[2px] rounded bg-black/55 text-white/90 backdrop-blur-md">
            Short
          </span>
        )}
      </div>

      <div className="p-5 space-y-5">
        <div>
          <h2 className="text-[16px] font-semibold leading-snug">{cv.title}</h2>
          <div className="mt-1.5 text-[12.5px] text-ink-dim flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              onClick={() => api.openInBrowser(cv.channel_url)}
              className="hover:text-accent hover:underline transition-colors"
              title={`Open ${cv.channel_name} on YouTube`}
            >
              {cv.channel_name}
            </button>
            <span className="text-ink-faint">·</span>
            <span>Youtube</span>
            {cv.duration ? (
              <>
                <span className="text-ink-faint">·</span>
                <span>{formatDuration(cv.duration)}</span>
              </>
            ) : null}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-faint">
            {formatUploadDate(cv.upload_date, "full", cv.upload_timestamp)
              ? `Uploaded ${formatUploadDate(
                  cv.upload_date,
                  "full",
                  cv.upload_timestamp
                )}`
              : "Upload date unknown"}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onOpen}
            className="flex-1 text-[13px] font-medium py-2 rounded-md bg-accent text-black hover:brightness-110 transition"
          >
            Play in browser
          </button>
          {cv.in_library ? (
            <span className="text-[13px] py-2 px-3 rounded-md border border-line bg-surface-2 text-accent inline-flex items-center gap-1">
              <span aria-hidden>✓</span> In your list
            </span>
          ) : (
            <button
              onClick={onAdd}
              disabled={busy}
              className="text-[13px] font-medium py-2 px-3 rounded-md bg-surface-2 hover:bg-line text-ink disabled:opacity-50 transition"
            >
              {busy ? "Adding…" : "+ Add to list"}
            </button>
          )}
        </div>

        {!cv.in_library && (
          <div className="pt-2 border-t border-line">
            <button
              onClick={onDismiss}
              disabled={busy}
              className="w-full text-[12.5px] font-medium py-2 px-3 rounded-md border border-danger/50 text-danger hover:bg-danger hover:text-danger-ink disabled:opacity-50 transition"
            >
              Dismiss from inbox
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
