import { useEffect, useState } from "react";
import * as api from "../api";
import { OFFLINE_AUDIO, OFFLINE_BEST } from "../settings";

type Props = {
  x: number;
  y: number;
  videoId: number;
  /// Current offline status of the video ("none" | "downloading" | "ready" |
  /// "error") — decides whether to offer a Remove/Cancel item.
  status: string;
  /// Download the video at the chosen max height (OFFLINE_BEST / OFFLINE_AUDIO
  /// sentinels allowed).
  onPick: (maxHeight: number) => void;
  /// Remove the download (if ready) or cancel it (if in flight).
  onClear: () => void;
  onClose: () => void;
};

/// Right-click menu listing a single video's available resolutions. Mirrors the
/// Sidebar TagContextMenu pattern: fixed-position, closes on any outside click,
/// right-click, or Escape. Fetches the real available heights on open.
export function DownloadQualityMenu({
  x,
  y,
  videoId,
  status,
  onPick,
  onClear,
  onClose,
}: Props) {
  const [heights, setHeights] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listVideoFormats(videoId)
      .then((hs) => {
        if (alive) setHeights(hs);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [videoId]);

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

  const pick = (h: number) => {
    onPick(h);
    onClose();
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", left: x, top: y, zIndex: 1000 }}
      className="min-w-[180px] max-h-[60vh] overflow-y-auto rounded-md border border-line bg-surface shadow-xl py-1 text-[12.5px]"
    >
      <div className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        Download quality
      </div>
      <button
        onClick={() => pick(OFFLINE_BEST)}
        className="block w-full text-left px-3 py-1.5 text-ink-dim hover:bg-surface-2 hover:text-ink"
      >
        Best available
      </button>
      {heights === null && !failed && (
        <div className="px-3 py-1.5 text-ink-faint">Loading resolutions…</div>
      )}
      {failed && (
        <div className="px-3 py-1.5 text-ink-faint">Couldn't list resolutions</div>
      )}
      {heights?.map((h) => (
        <button
          key={h}
          onClick={() => pick(h)}
          className="block w-full text-left px-3 py-1.5 text-ink-dim hover:bg-surface-2 hover:text-ink"
        >
          {h}p
        </button>
      ))}
      <button
        onClick={() => pick(OFFLINE_AUDIO)}
        className="block w-full text-left px-3 py-1.5 text-ink-dim hover:bg-surface-2 hover:text-ink"
      >
        Audio only (MP3)
      </button>
      {(status === "ready" || status === "downloading" || status === "error") && (
        <>
          <div className="my-1 border-t border-line" />
          <button
            onClick={() => {
              onClear();
              onClose();
            }}
            className="block w-full text-left px-3 py-1.5 text-ink-dim hover:bg-surface-2 hover:text-danger"
          >
            {status === "downloading" ? "Cancel download" : "Remove download"}
          </button>
        </>
      )}
    </div>
  );
}
