import { useMemo, useState } from "react";
import type { Channel, ChannelVideo } from "../types";
import {
  recencyBucket,
  RECENCY_LABELS,
  RECENCY_ORDER,
  type RecencyBucket,
} from "../utils";
import { InboxRow } from "./InboxRow";

type Props = {
  items: ChannelVideo[];
  totalItems: number;
  channels: Channel[];
  searchQuery: string;
  onClearSearch: () => void;
  onAdd: (cv: ChannelVideo) => Promise<void> | void;
  onDismiss: (cv: ChannelVideo) => Promise<void> | void;
  onOpen: (cv: ChannelVideo) => Promise<void> | void;
  onDismissAll: () => void;
  dismissingAll: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onDragStateChange?: (dragging: boolean) => void;
};

const BUCKET_HINTS: Record<RecencyBucket, string> = {
  today: "Hot off the press — uploaded today.",
  thisWeek: "From the past 7 days.",
  lastWeek: "Days 8–14 ago.",
  older: "Older than two weeks.",
};

export function InboxView({
  items,
  totalItems,
  channels,
  searchQuery,
  onClearSearch,
  onAdd,
  onDismiss,
  onOpen,
  onDismissAll,
  dismissingAll,
  refreshing,
  onRefresh,
  onDragStateChange,
}: Props) {
  const isFiltered = searchQuery.trim().length > 0;
  const [busy, setBusy] = useState<Set<number>>(new Set());

  const grouped = useMemo(() => {
    const m = new Map<RecencyBucket, ChannelVideo[]>();
    for (const it of items) {
      const b = recencyBucket(it.upload_date, it.first_seen_at, it.upload_timestamp);
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(it);
    }
    return RECENCY_ORDER.flatMap((b) => {
      const arr = m.get(b);
      return arr && arr.length > 0 ? [{ bucket: b, videos: arr }] : [];
    });
  }, [items]);

  const setItemBusy = (id: number, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const newCount = useMemo(
    () =>
      items.filter(
        (cv) =>
          recencyBucket(cv.upload_date, cv.first_seen_at, cv.upload_timestamp) !==
          "older"
      ).length,
    [items]
  );

  const wrap = (id: number, fn: () => Promise<void> | void) => async () => {
    setItemBusy(id, true);
    try {
      await fn();
    } finally {
      setItemBusy(id, false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 bg-canvas/95 backdrop-blur border-b border-line px-5 py-3 flex items-center justify-between">
        <div>
          <div className="text-[15px] font-semibold">Inbox</div>
          <div className="text-[12px] text-ink-dim">
            {isFiltered
              ? `${items.length} match${items.length === 1 ? "" : "es"} of ${totalItems}`
              : items.length === 0
              ? "No new videos right now"
              : `${newCount} new in past 2 weeks${
                  items.length > newCount
                    ? ` · ${items.length - newCount} earlier`
                    : ""
                }`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              onClick={onDismissAll}
              disabled={dismissingAll}
              className={
                "text-[12.5px] px-3 py-1.5 rounded-md border border-line transition-colors inline-flex items-center gap-1.5 min-w-[112px] justify-center " +
                (dismissingAll
                  ? "text-ink-faint bg-surface-2 cursor-default"
                  : "text-ink-dim hover:text-danger hover:border-danger/60")
              }
              title="Dismiss every item currently in your inbox"
            >
              {dismissingAll && (
                <span className="inline-block w-3 h-3 rounded-full border-2 border-ink-dim border-t-transparent animate-spin shrink-0" />
              )}
              <span>{dismissingAll ? "Dismissing" : "Dismiss all"}</span>
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className={
              "text-[12.5px] px-3 py-1.5 rounded-md border border-line transition-colors flex items-center gap-2 min-w-[112px] justify-center " +
              (refreshing
                ? "text-ink-faint bg-surface-2 cursor-default"
                : "text-ink-dim hover:text-ink hover:bg-surface-2")
            }
          >
            {refreshing && (
              <span className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
            )}
            <span>{refreshing ? "Checking" : "Check now"}</span>
          </button>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="h-[60%] flex items-center justify-center text-center px-6">
          <div>
            {isFiltered ? (
              <>
                <div className="text-[15px] font-semibold mb-1.5">No inbox matches</div>
                <div className="text-[12.5px] text-ink-dim">
                  Nothing in your inbox matches “{searchQuery}”.
                </div>
                <button
                  onClick={onClearSearch}
                  className="mt-4 text-[12.5px] px-3 py-1.5 rounded-md bg-accent text-black hover:brightness-110 transition"
                >
                  Clear search
                </button>
              </>
            ) : channels.length === 0 ? (
              <>
                <div className="text-[16px] font-semibold mb-2">
                  Follow a channel to start
                </div>
                <div className="text-[13px] text-ink-dim max-w-md leading-relaxed">
                  Use “Follow this channel” on any video, or paste a channel URL like{" "}
                  <code className="text-ink">youtube.com/@SomeChannel</code> into the
                  Add URL field. VidMinder checks for new uploads every 30 minutes.
                </div>
              </>
            ) : (
              <>
                <div className="text-[15px] font-semibold mb-1.5">All caught up</div>
                <div className="text-[12.5px] text-ink-dim">
                  Following {channels.length} {channels.length === 1 ? "channel" : "channels"} — no new uploads.
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="pb-5">
          {grouped.map(({ bucket, videos }) => (
            <section key={bucket} className="mb-4">
              <div className="sticky top-[57px] z-[5] bg-canvas/95 backdrop-blur px-5 py-2 flex items-baseline justify-between border-b border-line/60">
                <div className="flex items-baseline gap-3">
                  <h3 className="text-[13px] font-semibold tracking-tight">
                    {RECENCY_LABELS[bucket]}
                  </h3>
                  <span className="text-[11px] text-ink-faint tabular-nums">
                    {videos.length}
                  </span>
                </div>
                <span className="text-[11px] text-ink-faint hidden sm:block">
                  {BUCKET_HINTS[bucket]}
                </span>
              </div>
              <div className="px-5 pt-3 space-y-2">
                {videos.map((cv) => (
                  <InboxRow
                    key={cv.id}
                    cv={cv}
                    busy={busy.has(cv.id)}
                    onAdd={wrap(cv.id, () => onAdd(cv))}
                    onDismiss={wrap(cv.id, () => onDismiss(cv))}
                    onOpen={() => onOpen(cv)}
                    onDragStateChange={onDragStateChange}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

