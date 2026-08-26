import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, Channel as TauriChannel } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import "./App.css";
import * as api from "./api";
import type {
  Channel,
  ChannelVideo,
  Filter,
  IngestResult,
  Video,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { VideoCard } from "./components/VideoCard";
import { VideoDetails } from "./components/VideoDetails";
import { MultiVideoDetails } from "./components/MultiVideoDetails";
import { ChannelDetails } from "./components/ChannelDetails";
import { ChannelVideoDetails } from "./components/ChannelVideoDetails";
import { InboxView } from "./components/InboxView";
import { InboxRow } from "./components/InboxRow";
import { SettingsDialog } from "./components/SettingsDialog";
import { AboutDialog } from "./components/AboutDialog";
import { SearchPalette } from "./components/SearchPalette";
import { DownloadQualityMenu } from "./components/DownloadQualityMenu";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import {
  DRAG_MIME,
  INBOX_DRAG_MIME,
  extractUrlFromDrop,
  looksLikeChannelUrl,
  normalizeYouTubeInput,
  recencyBucket,
  RECENCY_LABELS,
  RECENCY_ORDER,
  uid,
  copyText,
} from "./utils";
import { OFFLINE_AUDIO, offlineQualityLabel, useSettings } from "./settings";
import { ensureRowDragImage } from "./dragImage";
import { isMac, isWeb, kbd, kbdClick, shiftClick } from "./platform";

type Pending = { id: string; url: string; kind: "video" | "channel" };
type SortMode = "added" | "uploaded" | "length";
type Toast = {
  id: number;
  kind: "ok" | "err" | "undo";
  text: string;
  action?: { label: string; onClick: () => void };
};

type UndoEntry = {
  id: number;
  description: string;
  expiresAt: number;
  undo: () => Promise<void> | void;
};

const UNDO_TOAST_MS = 6500;
const UNDO_TTL_MS = 90_000;
const UNDO_STACK_MAX = 40;

/// Encode an absolute filesystem path as a file:// URL (per-segment encoding
/// so spaces, #, etc. in titles survive).

/// Suggested export filename stem — mirrors the backend's `make_export_stem`
/// (sanitize filesystem-hostile characters, keep international text, append
/// the upload year).
function exportFileStem(video: Video): string {
  const sanitized = video.title
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  const short = [...sanitized].slice(0, 100).join("");
  const year =
    video.upload_date && video.upload_date.length >= 4
      ? video.upload_date.slice(0, 4)
      : null;
  return year ? `${short} (${year})` : short;
}

/** True if tag `t` is `base` or a dotted descendant of it (case-insensitive). */
function isTagOrSubtag(t: string, base: string): boolean {
  const lt = t.toLowerCase();
  const lb = base.toLowerCase();
  return lt === lb || lt.startsWith(`${lb}.`);
}

/**
 * Snapshot the full tag list of every video carrying `base` (or a sub-tag), so
 * a tag-tree edit (rename/delete) can be reverted by restoring those exact
 * lists. Correct across merges and capitalization-only changes.
 */
function tagAffectedSnapshot(
  vids: Video[],
  base: string
): { id: number; tags: string[] }[] {
  return vids
    .filter((v) => v.user_tags.some((t) => isTagOrSubtag(t, base)))
    .map((v) => ({ id: v.id, tags: [...v.user_tags] }));
}

const SORT_LABELS: Record<SortMode, string> = {
  added: "Date added",
  uploaded: "Upload date",
  length: "Length",
};

/**
 * Which sort options make sense in a given content context. A channel view
 * lists that channel's uploads (not items the user added to their library), so
 * "Date added" is irrelevant there.
 */
function sortOptionsFor(kind: Filter["kind"]): SortMode[] {
  if (kind === "channel") return ["uploaded", "length"];
  return ["added", "uploaded", "length"];
}

/** Sort a channel's inbox items by the active mode ("added" never applies). */
function sortChannelVideos(
  items: ChannelVideo[],
  mode: SortMode,
  dir: "desc" | "asc"
): ChannelVideo[] {
  const arr = [...items];
  if (mode === "length") {
    arr.sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1));
  } else {
    // "uploaded": mirror the inbox SQL order, COALESCE(upload_timestamp,
    // first_seen_at) DESC.
    const key = (cv: ChannelVideo) => cv.upload_timestamp ?? cv.first_seen_at;
    arr.sort((a, b) => key(b) - key(a));
  }
  if (dir === "asc") arr.reverse();
  return arr;
}

function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  // Always-current snapshot of `videos` for handlers that need to read the full
  // library without taking `videos` as a dependency (e.g. recording undo state
  // for tag-tree operations).
  const videosRef = useRef<Video[]>([]);
  videosRef.current = videos;
  // The currently *visible* list (filter + search + sort applied) — assigned
  // below once `filtered` is computed; read by the ⌘A select-all shortcut.
  const filteredRef = useRef<Video[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [inbox, setInbox] = useState<ChannelVideo[]>([]);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  // Multi-select. selectedIds carries the full selection; anchorId is the
  // pivot for shift-click range selects. Treat single selection as a set of
  // size 1 — the rest of the code branches on selectedIds.size.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [anchorId, setAnchorId] = useState<number | null>(null);
  // A channel-feed video (not yet in the library) selected for the details
  // panel. Mutually exclusive with library selection: selecting a library
  // video clears this, and selecting an inbox row clears selectedIds. Stored
  // by id so the panel tracks live updates (e.g. in_library flipping on Add).
  const [selectedInboxId, setSelectedInboxId] = useState<number | null>(null);
  // While the user is shift+mousedown-dragging through the list, this holds
  // the row they started on so each newly-entered row extends the range.
  const dragRangeAnchor = useRef<number | null>(null);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  // Channel URLs currently being followed via a Follow button (not the add
  // bar), so the button can show a busy state while the request is in flight.
  const [followingUrls, setFollowingUrls] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dragHover, setDragHover] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [followOpen, setFollowOpen] = useState(false);
  const [followInput, setFollowInput] = useState("");
  // Small-screen (below md) navigation drawer holding the sidebar, and the
  // below-lg bottom sheet that stands in for the right-hand details panel.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("added");
  // Sort direction. "desc" = the natural default for every mode (newest /
  // longest first); "asc" flips it (oldest / shortest first).
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // The macOS app menu's "About VidMinder" item opens the in-app About.
  useEffect(() => {
    const un = listen("open-about", () => setAboutOpen(true));
    return () => {
      un.then((f) => f());
    };
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [draggingVideo, setDraggingVideo] = useState(false);
  // Mirror for the window-level drag listeners: they're long-lived (bound
  // once), so they read the current value through a ref. True while ANY
  // in-app row drag is active — HTML5 or native file drag.
  const draggingVideoRef = useRef(false);
  useEffect(() => {
    draggingVideoRef.current = draggingVideo;
  }, [draggingVideo]);
  // Per-action in-flight trackers — keep buttons disabled and showing
  // progress until the underlying async work resolves.
  const [resurfacingChannelId, setResurfacingChannelId] = useState<number | null>(null);
  const [bulkDismissingScope, setBulkDismissingScope] = useState<string | null>(null);
  const [settings, updateSettings] = useSettings();
  // Live download progress (videoId -> percent 0–100) while a download runs.
  // The resting state (none/ready/error) lives on each Video via the DB.
  const [downloads, setDownloads] = useState<Map<number, number>>(new Map());
  // The right-click "choose resolution" menu, anchored at screen coords.
  const [qualityMenu, setQualityMenu] = useState<
    { videoId: number; status: string; x: number; y: number } | null
  >(null);
  // The right-click context menu for a video card.
  const [cardMenu, setCardMenu] = useState<
    { video: Video; x: number; y: number } | null
  >(null);

  const dragDepth = useRef(0);
  const toastSeq = useRef(0);
  const undoSeq = useRef(0);
  const undoStack = useRef<UndoEntry[]>([]);
  const toastEntryMap = useRef<Map<number, number>>(new Map());

  const removeToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    toastEntryMap.current.delete(id);
  }, []);

  const pushToast = useCallback(
    (toast: Omit<Toast, "id">, ttlMs = 4200) => {
      const id = ++toastSeq.current;
      setToasts((t) => [...t, { ...toast, id }]);
      setTimeout(() => removeToast(id), ttlMs);
      return id;
    },
    [removeToast]
  );

  const recordUndo = useCallback(
    (description: string, undo: () => Promise<void> | void) => {
      const now = Date.now();
      // Drop expired entries
      undoStack.current = undoStack.current.filter((e) => e.expiresAt > now);
      const entry: UndoEntry = {
        id: ++undoSeq.current,
        description,
        expiresAt: now + UNDO_TTL_MS,
        undo,
      };
      undoStack.current.push(entry);
      if (undoStack.current.length > UNDO_STACK_MAX) {
        undoStack.current.shift();
      }

      const toastId = pushToast(
        {
          kind: "undo",
          text: description,
          action: {
            label: "Undo",
            onClick: () => triggerUndoEntry(entry.id),
          },
        },
        UNDO_TOAST_MS
      );
      toastEntryMap.current.set(toastId, entry.id);
      return entry.id;
    },
    [pushToast]
  );

  const triggerUndoEntry = useCallback(
    async (entryId: number) => {
      const idx = undoStack.current.findIndex((e) => e.id === entryId);
      if (idx < 0) return;
      const [entry] = undoStack.current.splice(idx, 1);
      // Dismiss any toasts tied to this entry
      for (const [tid, eid] of toastEntryMap.current.entries()) {
        if (eid === entryId) removeToast(tid);
      }
      try {
        await entry.undo();
      } catch (e) {
        pushToast({ kind: "err", text: `Couldn't undo: ${e}` });
      }
    },
    [pushToast, removeToast]
  );

  const undoLast = useCallback(async () => {
    const now = Date.now();
    undoStack.current = undoStack.current.filter((e) => e.expiresAt > now);
    const entry = undoStack.current.pop();
    if (!entry) {
      pushToast({ kind: "ok", text: "Nothing to undo" });
      return;
    }
    for (const [tid, eid] of toastEntryMap.current.entries()) {
      if (eid === entry.id) removeToast(tid);
    }
    try {
      await entry.undo();
      pushToast({ kind: "ok", text: `Undid: ${entry.description}` });
    } catch (e) {
      pushToast({ kind: "err", text: `Couldn't undo: ${e}` });
    }
  }, [pushToast, removeToast]);

  // Initial load
  const refreshVideos = useCallback(async () => {
    try {
      setVideos(await api.listVideos());
    } catch (e) {
      pushToast({ kind: "err", text: `Could not load library: ${e}` });
    }
  }, [pushToast]);

  const refreshChannelsList = useCallback(async () => {
    try {
      setChannels(await api.listChannels());
    } catch (e) {
      pushToast({ kind: "err", text: `Could not load channels: ${e}` });
    }
  }, [pushToast]);

  const refreshInbox = useCallback(async () => {
    try {
      setInbox(await api.listInbox());
    } catch (e) {
      pushToast({ kind: "err", text: `Could not load inbox: ${e}` });
    }
  }, [pushToast]);

  useEffect(() => {
    refreshVideos();
    refreshChannelsList();
    refreshInbox();
  }, [refreshVideos, refreshChannelsList, refreshInbox]);

  // Periodic channel refresh, frequency controlled by user setting.
  // The Rust side handles the initial startup poll; we own the recurring
  // schedule here so changes take effect immediately without a restart.
  useEffect(() => {
    const minutes = settings.pollIntervalMinutes;
    if (!minutes || minutes <= 0) return; // "Manual only"
    const id = setInterval(() => {
      // Fire-and-forget — manual Refresh surfaces errors via toast; the
      // background tick is meant to be quiet, so swallow silently.
      api.refreshChannels().catch(() => {});
    }, minutes * 60 * 1000);
    return () => clearInterval(id);
  }, [settings.pollIntervalMinutes]);

  // Push the channel lookback window to the backend on startup and whenever it
  // changes, so following a channel / Catch up uses the user's chosen depth.
  useEffect(() => {
    api.setChannelLookbackDays(settings.channelLookbackDays).catch(() => {});
  }, [settings.channelLookbackDays]);

  useEffect(() => {
    api.setCookiesBrowser(settings.cookiesBrowser).catch(() => {});
  }, [settings.cookiesBrowser]);

  // Thumbnails are remote <img src=…> hitting YouTube's CDN. When the machine
  // sleeps, any in-flight (or subsequently attempted) load fails and WKWebView
  // marks that <img> permanently broken — it never retries when the network
  // returns, leaving a wall of broken-image placeholders after wake. Whenever
  // we regain focus / visibility / connectivity, nudge every broken image to
  // re-fetch by clearing and restoring its src on the next frame.
  useEffect(() => {
    const reviveBrokenImages = () => {
      document.querySelectorAll("img").forEach((img) => {
        // complete && naturalWidth === 0 is the canonical "load failed" test.
        if (img.complete && img.naturalWidth === 0 && img.src) {
          const src = img.src;
          img.src = "";
          requestAnimationFrame(() => {
            img.src = src;
          });
        }
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reviveBrokenImages();
    };
    window.addEventListener("focus", reviveBrokenImages);
    window.addEventListener("online", reviveBrokenImages);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", reviveBrokenImages);
      window.removeEventListener("online", reviveBrokenImages);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Backend events (e.g. background polling brought in new inbox items)
  useEffect(() => {
    const ul1 = listen("videos-changed", () => {
      refreshVideos();
      // Library membership drives the channel feed's in_library badges and
      // the Mixed/Separate grouping — keep them in lock-step.
      refreshInbox();
    });
    const ul2 = listen("channels-changed", () => {
      refreshChannelsList();
      refreshInbox();
    });
    const ul3 = listen("inbox-changed", () => {
      refreshInbox();
      refreshChannelsList();
    });
    const ul4 = listen<{
      id: number;
      percent: number;
      status: string;
      message?: string;
    }>("download-progress", (e) => {
      const { id, percent, status, message } = e.payload;
      setDownloads((m) => {
        const next = new Map(m);
        if (status === "downloading") next.set(id, percent);
        else next.delete(id); // ready / error / none — resting state on the Video
        return next;
      });
      if (status === "error") {
        pushToast({
          kind: "err",
          text: message ? `Download failed: ${message}` : "Download failed",
        });
      }
    });
    return () => {
      ul1.then((f) => f());
      ul2.then((f) => f());
      ul3.then((f) => f());
      ul4.then((f) => f());
    };
  }, [refreshVideos, refreshChannelsList, refreshInbox, pushToast]);

  // --- Offline downloads -----------------------------------------------------
  const handleDownloadVideo = useCallback(
    (videoId: number, maxHeight: number) => {
      // Optimistically show the ring immediately; the backend confirms via
      // download-progress + videos-changed.
      setDownloads((m) => new Map(m).set(videoId, 0));
      api.downloadVideo(videoId, maxHeight).catch((e) => {
        setDownloads((m) => {
          const next = new Map(m);
          next.delete(videoId);
          return next;
        });
        pushToast({ kind: "err", text: `Couldn't start download: ${e}` });
      });
    },
    [pushToast]
  );

  const handleCancelDownload = useCallback((videoId: number) => {
    api.cancelDownload(videoId).catch(() => {});
  }, []);

  const handleDeleteOffline = useCallback((videoId: number) => {
    api.deleteOffline(videoId).catch(() => {});
  }, []);

  const handlePlayOffline = useCallback(
    async (video: Video) => {
      try {
        const opened = await api.openOffline(video.id);
        if (!opened) {
          // The downloaded file was removed outside the app — the backend reset
          // its status; open the video online instead.
          api.openVideoInBrowser(video.url);
        }
      } catch (e) {
        pushToast({ kind: "err", text: `Couldn't open file: ${e}` });
      }
    },
    [pushToast]
  );

  const handleRevealOfflineFile = useCallback(
    (videoId: number) => {
      api.revealOfflineFile(videoId).catch((e) =>
        pushToast({ kind: "err", text: `Couldn't show file: ${e}` })
      );
    },
    [pushToast]
  );

  // Native OS file drag for a video row. On macOS this is a FILE-PROMISE drag
  // (start_export_drag): Finder shows the copy cursor and accepts the drop for
  // downloaded AND not-yet-downloaded videos — the backend downloads to the
  // offline store if needed, then writes the file at the drop location. The
  // drag also carries the video URL as text, so in-app tag drops keep working.
  // On other platforms (downloaded videos only) it falls back to the drag
  // plugin carrying a pre-copied file URL.
  const handleNativeFileDrag = useCallback(
    async (video: Video) => {
      try {
        setDraggingVideo(true);
        const { dataUrl: image } = await ensureRowDragImage(`v${video.id}`, {
          title: video.title,
          subtitle: video.uploader ?? video.source,
          thumbnailUrl: video.thumbnail_url,
        });
        const onEvent = new TauriChannel<unknown>();
        // The drag session ends (drop or cancel) → clear the drop-target
        // affordances in the sidebar.
        onEvent.onmessage = () => setDraggingVideo(false);
        if (isMac) {
          await invoke("start_export_drag", {
            videoId: video.id,
            maxHeight: settings.offlineMaxHeight,
            image,
            onEvent,
          });
          return;
        }
        const path = await api.prepareExportFile(video.id);
        // plugin:drag|start_drag needs the raw base64 PNG, not the full data URL
        const imageB64 = image.includes(",") ? image.split(",")[1] : image;
        await invoke("plugin:drag|start_drag", {
          item: { paths: [path] },
          image: imageB64,
          onEvent,
        });
      } catch (err) {
        setDraggingVideo(false);
        pushToast({ kind: "err", text: `Export failed: ${err}` });
      }
    },
    [settings.offlineMaxHeight, pushToast]
  );

  // Export via a save dialog: the user picks where the file goes. If the
  // video isn't offline yet it's downloaded into the offline store first
  // (normal pipeline — progress ring, the app keeps the copy), then the
  // export is a plain file copy to the chosen path.
  const handleExportVideo = useCallback(
    async (video: Video) => {
      const ready = video.offline_status === "ready";
      const ext =
        ready && video.offline_path
          ? video.offline_path.split(".").pop() || "mp4"
          : settings.offlineMaxHeight === OFFLINE_AUDIO
          ? "mp3"
          : "mp4";
      let chosen: string | null = null;
      try {
        const dir = await downloadDir().catch(() => null);
        const name = `${exportFileStem(video)}.${ext}`;
        chosen = await saveDialog({
          defaultPath: dir ? `${dir}/${name}` : name,
          filters: [{ name: "Video", extensions: [ext] }],
        });
      } catch (err) {
        pushToast({ kind: "err", text: `Couldn't open save dialog: ${err}` });
        return;
      }
      if (!chosen) return; // user cancelled
      if (!ready) {
        pushToast({
          kind: "ok",
          text: `Downloading “${video.title}” — it will be exported when done`,
        });
      }
      try {
        const path = await api.exportVideoTo(
          video.id,
          chosen,
          settings.offlineMaxHeight
        );
        const filename = path.split(/[\\/]/).pop() ?? path;
        pushToast({
          kind: "ok",
          text: `Exported: ${filename}`,
          action: {
            label: `Show in ${isMac ? "Finder" : "Explorer"}`,
            onClick: () => api.revealPath(path).catch(() => {}),
          },
        });
      } catch (err) {
        pushToast({ kind: "err", text: `Export failed: ${err}` });
      }
    },
    [settings.offlineMaxHeight, pushToast]
  );

  // Used when a non-downloaded video row is dragged out of the app window on
  // Windows/Linux. File promises aren't available on those platforms, so we
  // can't know where the user dropped it — instead we download to the offline
  // store and copy to the system Downloads folder automatically (no dialog).
  const handleDragOutExport = useCallback(
    async (video: Video) => {
      const ext = settings.offlineMaxHeight === OFFLINE_AUDIO ? "mp3" : "mp4";
      const name = `${exportFileStem(video)}.${ext}`;
      try {
        const dir = await downloadDir().catch(() => null);
        if (!dir) {
          // No Downloads folder — fall back to the save dialog.
          return handleExportVideo(video);
        }
        const dest = `${dir}/${name}`;
        pushToast({
          kind: "ok",
          text: `Exporting "${video.title}" — saving to Downloads when ready`,
        });
        const path = await api.exportVideoTo(
          video.id,
          dest,
          settings.offlineMaxHeight
        );
        const filename = path.split(/[\\/]/).pop() ?? path;
        pushToast({
          kind: "ok",
          text: `Exported: ${filename}`,
          action: {
            label: `Show in ${isMac ? "Finder" : "Explorer"}`,
            onClick: () => api.revealPath(path).catch(() => {}),
          },
        });
      } catch (err) {
        pushToast({ kind: "err", text: `Export failed: ${err}` });
      }
    },
    [settings.offlineMaxHeight, pushToast, handleExportVideo]
  );

  const handleBatchRemoveDownloads = useCallback(
    async (vids: Video[]) => {
      const targets = vids.filter((v) => v.offline_status !== "none");
      if (targets.length === 0) return;
      const results = await Promise.allSettled(
        targets.map((v) => api.deleteOffline(v.id))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      pushToast(
        failed > 0
          ? { kind: "err", text: `Couldn't remove ${failed} of ${targets.length} downloads` }
          : {
              kind: "ok",
              text: `Removed ${targets.length} ${targets.length === 1 ? "download" : "downloads"}`,
            }
      );
    },
    [pushToast]
  );

  const handleBatchDownload = useCallback(
    (vids: Video[], maxHeight: number) => {
      const ids = vids.map((v) => v.id);
      setDownloads((m) => {
        const next = new Map(m);
        for (const id of ids) next.set(id, 0);
        return next;
      });
      api.downloadVideos(ids, maxHeight).catch((e) =>
        pushToast({ kind: "err", text: `Couldn't start downloads: ${e}` })
      );
    },
    [pushToast]
  );

  // Suppress the WebView's default right-click menu (Reload / Inspect / Back …)
  // everywhere except inside editable fields, where cut/copy/paste is useful.
  // Our own onContextMenu handlers stopPropagation, so the custom menus below
  // still open; bare elements just get no native menu.
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const editable =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (!editable) e.preventDefault();
    };
    document.addEventListener("contextmenu", onContext);
    return () => document.removeEventListener("contextmenu", onContext);
  }, []);

  // ---------------------------------------------------------------------------
  // Mutations — each records an undo entry
  // ---------------------------------------------------------------------------

  const insertVideoLocally = useCallback((v: Video) => {
    setVideos((prev) => {
      const without = prev.filter((x) => x.id !== v.id);
      const next = [v, ...without];
      next.sort((a, b) => b.added_at - a.added_at);
      return next;
    });
  }, []);

  const removeVideoLocally = useCallback((id: number) => {
    setVideos((prev) => prev.filter((v) => v.id !== id));
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setAnchorId((cur) => (cur === id ? null : cur));
  }, []);

  const selectSingle = useCallback((id: number) => {
    setSelectedIds(new Set([id]));
    setAnchorId(id);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setAnchorId(null);
    setSelectedInboxId(null);
  }, []);

  // Single-click an inbox / channel-feed row → show its details on the right.
  // Clears any library selection so the two panels never fight.
  // On viewports without the right-hand details panel (below lg), selecting a
  // row pops the details up as a bottom sheet instead.
  const openMobileDetails = useCallback(() => {
    if (window.matchMedia("(max-width: 1023px)").matches) {
      setMobileDetailsOpen(true);
    }
  }, []);

  const handleInboxSelect = useCallback(
    (cv: ChannelVideo) => {
      setSelectedIds(new Set());
      setAnchorId(null);
      setSelectedInboxId(cv.id);
      openMobileDetails();
    },
    [openMobileDetails]
  );

  // Mutual exclusion: any library selection wins, dropping the inbox panel.
  useEffect(() => {
    if (selectedIds.size > 0) setSelectedInboxId(null);
  }, [selectedIds]);

  // The mobile details sheet has nothing to show once the selection is gone
  // (deleted, dismissed, Escape) or the view switches to the inbox, which has
  // no details panel on desktop either.
  useEffect(() => {
    if (
      filter.kind === "inbox" ||
      (selectedIds.size === 0 && selectedInboxId === null)
    ) {
      setMobileDetailsOpen(false);
    }
  }, [filter.kind, selectedIds, selectedInboxId]);

  const handleIngestResult = useCallback(
    async (result: IngestResult) => {
      if (result.kind === "video") {
        let v = result.value;
        // Auto-favorite if the setting is on and the video wasn't already starred.
        if (settings.autoFavorite && !v.favorite) {
          try {
            await api.setFavorite(v.id, true);
            v = { ...v, favorite: true };
          } catch {
            /* non-fatal: ingest succeeded */
          }
        }
        insertVideoLocally(v);
        selectSingle(v.id);
        if (filter.kind === "inbox") setFilter({ kind: "all" });
        // The video may correspond to a channel-feed row — refresh so its
        // in_library flag flips (badge + Mixed/Separate grouping).
        refreshInbox();
        recordUndo(`Added “${v.title.slice(0, 50)}”`, async () => {
          await api.deleteVideo(v.id);
          removeVideoLocally(v.id);
          refreshInbox();
        });
      } else {
        const ch = result.value;
        setChannels((prev) => {
          const without = prev.filter((c) => c.id !== ch.id);
          return [...without, ch].sort((a, b) => a.name.localeCompare(b.name));
        });
        refreshInbox();
        recordUndo(`Followed ${ch.name}`, async () => {
          await api.unfollowChannel(ch.id);
          setChannels((prev) => prev.filter((c) => c.id !== ch.id));
          refreshInbox();
        });
      }
    },
    [
      filter.kind,
      insertVideoLocally,
      recordUndo,
      refreshInbox,
      removeVideoLocally,
      settings.autoFavorite,
    ]
  );

  const ingest = useCallback(
    async (rawUrl: string, opts?: { explicitChannel?: boolean }) => {
      const trimmed = rawUrl.trim();
      if (!trimmed) return;
      const url = normalizeYouTubeInput(trimmed);
      if (!url) {
        pushToast({
          kind: "err",
          text: `Couldn't interpret "${trimmed.slice(0, 40)}" as a YouTube URL, @handle, or channel ID`,
        });
        return;
      }
      const pendId = uid();
      const pendKind: "video" | "channel" =
        opts?.explicitChannel || looksLikeChannelUrl(url) ? "channel" : "video";
      setPending((p) => [...p, { id: pendId, url, kind: pendKind }]);
      try {
        const result: IngestResult = opts?.explicitChannel
          ? { kind: "channel", value: await api.followChannel(url) }
          : await api.ingestUrl(url);
        await handleIngestResult(result);
      } catch (e) {
        pushToast({ kind: "err", text: String(e).replace(/^Error: /, "") });
      } finally {
        setPending((p) => p.filter((x) => x.id !== pendId));
      }
    },
    [handleIngestResult, pushToast]
  );

  const handleDeleteVideo = useCallback(
    async (target: Video) => {
      removeVideoLocally(target.id);
      try {
        await api.deleteVideo(target.id);
      } catch (e) {
        insertVideoLocally(target);
        selectSingle(target.id);
        pushToast({ kind: "err", text: `Couldn't remove: ${e}` });
        return;
      }
      // Flip the channel-feed row's in_library flag back off so the feed
      // (badge, Mixed/Separate grouping) reflects the removal immediately.
      refreshInbox();
      recordUndo(`Removed “${target.title.slice(0, 50)}”`, async () => {
        const restored = await api.restoreVideo(target);
        insertVideoLocally(restored);
        selectSingle(restored.id);
        refreshInbox();
      });
    },
    [insertVideoLocally, pushToast, recordUndo, refreshInbox, removeVideoLocally, selectSingle]
  );

  // -----------------------------------------------------------------------
  // Bulk mutations for multi-select edits. Each builds a snapshot of prior
  // state so undo can restore the per-video values (not just the group state).
  // -----------------------------------------------------------------------

  const handleSetWatchedMany = useCallback(
    async (videosArr: Video[], watched: boolean) => {
      if (videosArr.length === 0) return;
      const snapshot = videosArr.map((v) => ({ id: v.id, prev: v.watched }));
      const toUpdate = videosArr.filter((v) => v.watched !== watched);
      if (toUpdate.length === 0) return;
      const idSet = new Set(snapshot.map((s) => s.id));
      setVideos((prev) =>
        prev.map((v) => (idSet.has(v.id) ? { ...v, watched } : v))
      );
      try {
        await Promise.all(toUpdate.map((v) => api.setWatched(v.id, watched)));
      } catch (e) {
        // Roll back
        setVideos((prev) =>
          prev.map((v) => {
            const s = snapshot.find((s) => s.id === v.id);
            return s ? { ...v, watched: s.prev } : v;
          })
        );
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      const label = watched
        ? `Marked ${toUpdate.length} watched`
        : `Unmarked ${toUpdate.length} watched`;
      recordUndo(label, async () => {
        await Promise.all(snapshot.map((s) => api.setWatched(s.id, s.prev)));
        setVideos((prev) =>
          prev.map((v) => {
            const s = snapshot.find((s) => s.id === v.id);
            return s ? { ...v, watched: s.prev } : v;
          })
        );
      });
    },
    [pushToast, recordUndo]
  );

  const handleSetFavoriteMany = useCallback(
    async (videosArr: Video[], favorite: boolean) => {
      if (videosArr.length === 0) return;
      const snapshot = videosArr.map((v) => ({ id: v.id, prev: v.favorite }));
      const toUpdate = videosArr.filter((v) => v.favorite !== favorite);
      if (toUpdate.length === 0) return;
      const idSet = new Set(snapshot.map((s) => s.id));
      setVideos((prev) =>
        prev.map((v) => (idSet.has(v.id) ? { ...v, favorite } : v))
      );
      try {
        await Promise.all(toUpdate.map((v) => api.setFavorite(v.id, favorite)));
      } catch (e) {
        setVideos((prev) =>
          prev.map((v) => {
            const s = snapshot.find((s) => s.id === v.id);
            return s ? { ...v, favorite: s.prev } : v;
          })
        );
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      const label = favorite
        ? `Favorited ${toUpdate.length}`
        : `Unfavorited ${toUpdate.length}`;
      recordUndo(label, async () => {
        await Promise.all(snapshot.map((s) => api.setFavorite(s.id, s.prev)));
        setVideos((prev) =>
          prev.map((v) => {
            const s = snapshot.find((s) => s.id === v.id);
            return s ? { ...v, favorite: s.prev } : v;
          })
        );
      });
    },
    [pushToast, recordUndo]
  );

  const handleAddTagMany = useCallback(
    async (videosArr: Video[], tag: string) => {
      const cleaned = tag.trim();
      if (!cleaned || videosArr.length === 0) return;
      const lc = cleaned.toLowerCase();
      const targets = videosArr.filter(
        (v) => !v.user_tags.some((t) => t.toLowerCase() === lc)
      );
      if (targets.length === 0) return;
      let updates: { id: number; tags: string[] }[];
      try {
        updates = await Promise.all(
          targets.map(async (v) => ({
            id: v.id,
            tags: await api.addTag(v.id, cleaned),
          }))
        );
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      setVideos((prev) =>
        prev.map((v) => {
          const u = updates.find((x) => x.id === v.id);
          return u ? { ...v, user_tags: u.tags } : v;
        })
      );
      recordUndo(`Tagged ${targets.length} with #${cleaned}`, async () => {
        const back = await Promise.all(
          targets.map(async (v) => ({
            id: v.id,
            tags: await api.removeTag(v.id, cleaned),
          }))
        );
        setVideos((prev) =>
          prev.map((v) => {
            const b = back.find((x) => x.id === v.id);
            return b ? { ...v, user_tags: b.tags } : v;
          })
        );
      });
    },
    [pushToast, recordUndo]
  );

  const handleRemoveTagMany = useCallback(
    async (videosArr: Video[], tag: string) => {
      const lc = tag.toLowerCase();
      const targets = videosArr.filter((v) =>
        v.user_tags.some((t) => t.toLowerCase() === lc)
      );
      if (targets.length === 0) return;
      let updates: { id: number; tags: string[] }[];
      try {
        updates = await Promise.all(
          targets.map(async (v) => ({
            id: v.id,
            tags: await api.removeTag(v.id, tag),
          }))
        );
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      setVideos((prev) =>
        prev.map((v) => {
          const u = updates.find((x) => x.id === v.id);
          return u ? { ...v, user_tags: u.tags } : v;
        })
      );
      recordUndo(`Removed #${tag} from ${targets.length}`, async () => {
        const back = await Promise.all(
          targets.map(async (v) => ({
            id: v.id,
            tags: await api.addTag(v.id, tag),
          }))
        );
        setVideos((prev) =>
          prev.map((v) => {
            const b = back.find((x) => x.id === v.id);
            return b ? { ...v, user_tags: b.tags } : v;
          })
        );
      });
    },
    [pushToast, recordUndo]
  );

  // -----------------------------------------------------------------------
  // Tag-tree operations (Calibre-style dotted tags). Sub-tags are part of
  // their parent's namespace, so `delete_tag("foo")` removes "foo", "foo.bar",
  // "foo.bar.baz", … in one shot. Rename re-paths the whole subtree.
  // -----------------------------------------------------------------------

  // Undo for tag-tree edits: rewrite each affected video's tags back to its
  // snapshot, then resync from the backend.
  const restoreTagSnapshot = useCallback(
    async (snapshot: { id: number; tags: string[] }[]) => {
      await Promise.all(snapshot.map((s) => api.setVideoTags(s.id, s.tags)));
      try {
        const fresh = await api.listVideos();
        setVideos(fresh);
      } catch {
        /* non-fatal — next event will resync */
      }
    },
    []
  );

  const handleRenameTag = useCallback(
    async (oldTag: string, newTag: string) => {
      const a = oldTag.trim();
      const b = newTag.trim();
      if (!a || !b || a === b) return;
      // Snapshot the full tag list of every video the rename will touch, so undo
      // can restore them exactly (robust even if the rename merged into an
      // existing tag or only changed capitalization).
      const affected = tagAffectedSnapshot(videosRef.current, a);
      try {
        await api.renameTag(a, b);
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      // Refresh the canonical tag set from the backend — rename rebinds rows
      // across many videos, and we want the new dotted names everywhere.
      try {
        const fresh = await api.listVideos();
        setVideos(fresh);
      } catch {
        /* non-fatal — next event will resync */
      }
      // If the active filter was on a node we just renamed (or its descendant),
      // move it to the new path.
      if (filter.kind === "tag") {
        if (filter.name === a) {
          setFilter({ kind: "tag", name: b });
        } else if (filter.name.startsWith(`${a}.`)) {
          setFilter({ kind: "tag", name: b + filter.name.slice(a.length) });
        }
      }
      recordUndo(`Renamed “${a}” → “${b}”`, () => restoreTagSnapshot(affected));
    },
    [filter, pushToast, recordUndo, restoreTagSnapshot]
  );

  const handleDeleteTag = useCallback(
    async (tag: string) => {
      // Snapshot every video carrying this tag (or a sub-tag) before deletion so
      // undo can restore the exact tag lists.
      const affected = tagAffectedSnapshot(videosRef.current, tag);
      try {
        await api.deleteTag(tag);
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      try {
        const fresh = await api.listVideos();
        setVideos(fresh);
      } catch {
        /* non-fatal */
      }
      if (
        filter.kind === "tag" &&
        (filter.name === tag || filter.name.startsWith(`${tag}.`))
      ) {
        setFilter({ kind: "all" });
      }
      recordUndo(`Deleted tag “${tag}”`, () => restoreTagSnapshot(affected));
    },
    [filter, pushToast, recordUndo, restoreTagSnapshot]
  );

  // Dropping a URL onto a tag node: ingest the video into the library, then
  // tag it (auto-adding to the library en route).
  const handleDropUrlToTag = useCallback(
    async (rawUrl: string, tag: string) => {
      const url = normalizeYouTubeInput(rawUrl);
      if (!url) {
        pushToast({ kind: "err", text: "Only YouTube URLs can be added by drag-drop" });
        return;
      }
      const pendId = uid();
      setPending((p) => [...p, { id: pendId, url, kind: "video" }]);
      try {
        const result = await api.ingestUrl(url);
        if (result.kind !== "video") {
          pushToast({
            kind: "err",
            text: "That's a channel URL — drop a single video onto a tag",
          });
          return;
        }
        let v = result.value;
        if (settings.autoFavorite && !v.favorite) {
          try {
            await api.setFavorite(v.id, true);
            v = { ...v, favorite: true };
          } catch {
            /* non-fatal */
          }
        }
        const updatedTags = await api.addTag(v.id, tag);
        const withTag = { ...v, user_tags: updatedTags };
        insertVideoLocally(withTag);
        pushToast({
          kind: "ok",
          text: `Added “${v.title.slice(0, 50)}” with #${tag}`,
        });
      } catch (e) {
        pushToast({ kind: "err", text: String(e).replace(/^Error: /, "") });
      } finally {
        setPending((p) => p.filter((x) => x.id !== pendId));
      }
    },
    [insertVideoLocally, pushToast, settings.autoFavorite]
  );

  const handleDeleteVideos = useCallback(
    async (targets: Video[]) => {
      if (targets.length === 0) return;
      if (targets.length === 1) {
        await handleDeleteVideo(targets[0]);
        return;
      }
      // Snapshot so we can restore the whole batch on undo.
      const snapshots = targets.map((v) => ({ ...v }));
      // Optimistic UI: remove everything immediately.
      setVideos((prev) => {
        const ids = new Set(snapshots.map((v) => v.id));
        return prev.filter((v) => !ids.has(v.id));
      });
      clearSelection();
      // Fire delete calls in parallel.
      const results = await Promise.allSettled(
        snapshots.map((v) => api.deleteVideo(v.id))
      );
      const failed: Video[] = [];
      results.forEach((r, i) => {
        if (r.status === "rejected") failed.push(snapshots[i]);
      });
      if (failed.length > 0) {
        // Restore optimistic-removed videos that failed to delete.
        setVideos((prev) => {
          const next = [...prev, ...failed];
          next.sort((a, b) => b.added_at - a.added_at);
          return next;
        });
        pushToast({
          kind: "err",
          text: `Couldn't remove ${failed.length} of ${snapshots.length}`,
        });
      }
      const successfullyDeleted = snapshots.filter(
        (_, i) => results[i].status === "fulfilled"
      );
      if (successfullyDeleted.length > 0) {
        refreshInbox();
        recordUndo(
          `Removed ${successfullyDeleted.length} videos`,
          async () => {
            const restored = await Promise.all(
              successfullyDeleted.map((v) => api.restoreVideo(v))
            );
            setVideos((prev) => {
              const next = [...prev, ...restored];
              next.sort((a, b) => b.added_at - a.added_at);
              return next;
            });
            setSelectedIds(new Set(restored.map((r) => r.id)));
            refreshInbox();
          }
        );
      }
    },
    [clearSelection, handleDeleteVideo, pushToast, recordUndo, refreshInbox]
  );

  const handleToggleWatched = useCallback(
    async (video: Video) => {
      const previous = video.watched;
      const next = !previous;
      setVideos((prev) =>
        prev.map((v) => (v.id === video.id ? { ...v, watched: next } : v))
      );
      try {
        await api.setWatched(video.id, next);
      } catch (e) {
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, watched: previous } : v))
        );
        pushToast({ kind: "err", text: `Couldn't update watched: ${e}` });
        return;
      }
      recordUndo(next ? "Marked watched" : "Marked unwatched", async () => {
        await api.setWatched(video.id, previous);
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, watched: previous } : v))
        );
      });
    },
    [pushToast, recordUndo]
  );

  const handleOpenAndMarkWatched = useCallback(
    (video: Video) => {
      api.openVideoInBrowser(video.url);
      if (!video.watched) {
        // handleToggleWatched already records an undo, so ⌘Z un-marks it.
        handleToggleWatched(video);
      }
    },
    [handleToggleWatched]
  );

  // Double-clicking a card opens the downloaded file if there is one, else the
  // website. (The details panel keeps a distinct "Play in browser" button.)
  const handleCardOpen = useCallback(
    (video: Video) => {
      if (video.offline_status === "ready" && video.offline_path) {
        handlePlayOffline(video);
      } else {
        api.openVideoInBrowser(video.url);
      }
      if (!video.watched) handleToggleWatched(video);
    },
    [handlePlayOffline, handleToggleWatched]
  );

  const handleToggleFavorite = useCallback(
    async (video: Video) => {
      const previous = video.favorite;
      const next = !previous;
      setVideos((prev) =>
        prev.map((v) => (v.id === video.id ? { ...v, favorite: next } : v))
      );
      try {
        await api.setFavorite(video.id, next);
      } catch (e) {
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, favorite: previous } : v))
        );
        pushToast({ kind: "err", text: `Couldn't update favorite: ${e}` });
        return;
      }
      recordUndo(
        next ? "Added to favorites" : "Removed from favorites",
        async () => {
          await api.setFavorite(video.id, previous);
          setVideos((prev) =>
            prev.map((v) => (v.id === video.id ? { ...v, favorite: previous } : v))
          );
        }
      );
    },
    [pushToast, recordUndo]
  );

  // Build the right-click menu for a video card from the in-app actions.
  const videoMenuItems = useCallback(
    (video: Video): MenuItem[] => {
      const status = video.offline_status;
      const items: MenuItem[] = [
        { label: "Open on YouTube", onClick: () => handleOpenAndMarkWatched(video) },
      ];
      // Offline downloads / file export are desktop-only (the web Worker has
      // no yt-dlp/ffmpeg) — skip the whole section on web.
      if (!isWeb) {
        if (status === "ready") {
          items.push({ label: "Play downloaded file", onClick: () => handlePlayOffline(video) });
          items.push({
            label: `Show in ${isMac ? "Finder" : "Explorer"}`,
            onClick: () => handleRevealOfflineFile(video.id),
          });
        }
        // Available for every status — non-downloaded videos download first.
        items.push({
          label: "Export video file…",
          onClick: () => handleExportVideo(video),
        });
        items.push({ kind: "separator" });
        if (status === "ready") {
          items.push({ label: "Remove download", onClick: () => handleDeleteOffline(video.id) });
        } else if (status === "downloading") {
          items.push({ label: "Cancel download", onClick: () => handleCancelDownload(video.id) });
        } else {
          items.push({
            label: `Download (${offlineQualityLabel(settings.offlineMaxHeight)})`,
            onClick: () => handleDownloadVideo(video.id, settings.offlineMaxHeight),
          });
        }
      }
      items.push(
        { kind: "separator" },
        {
          label: video.favorite ? "Remove from favorites" : "Add to favorites",
          onClick: () => handleToggleFavorite(video),
        },
        {
          label: video.watched ? "Mark unwatched" : "Mark watched",
          onClick: () => handleToggleWatched(video),
        },
        { kind: "separator" },
        {
          label: "Copy video link",
          onClick: () => {
            copyText(video.url);
            pushToast({ kind: "ok", text: "Link copied" });
          },
        }
      );
      if (video.channel_url) {
        items.push({
          label: `Open ${video.uploader ?? "channel"} on YouTube`,
          onClick: () => api.openInBrowser(video.channel_url!),
        });
      }
      items.push(
        { kind: "separator" },
        { label: "Remove from library", danger: true, onClick: () => handleDeleteVideo(video) }
      );
      return items;
    },
    [
      settings.offlineMaxHeight,
      handleOpenAndMarkWatched,
      handlePlayOffline,
      handleDeleteOffline,
      handleCancelDownload,
      handleDownloadVideo,
      handleToggleFavorite,
      handleToggleWatched,
      handleDeleteVideo,
      handleRevealOfflineFile,
      handleExportVideo,
      pushToast,
    ]
  );

  const handleAddTag = useCallback(
    async (video: Video, tag: string) => {
      const cleaned = tag.trim();
      if (!cleaned || video.user_tags.some((t) => t.toLowerCase() === cleaned.toLowerCase())) {
        return;
      }
      let tags: string[];
      try {
        tags = await api.addTag(video.id, cleaned);
      } catch (e) {
        pushToast({ kind: "err", text: `Couldn't add tag: ${e}` });
        return;
      }
      setVideos((prev) =>
        prev.map((v) => (v.id === video.id ? { ...v, user_tags: tags } : v))
      );
      recordUndo(`Added tag #${cleaned}`, async () => {
        const updated = await api.removeTag(video.id, cleaned);
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, user_tags: updated } : v))
        );
      });
    },
    [pushToast, recordUndo]
  );

  // Replace the entire user_tags set on one video. Used by the dotted-tag
  // editor in the details pane — it commits the full intent in one shot so
  // canonical-casing happens server-side instead of via accreted add/remove.
  const handleSetTags = useCallback(
    async (video: Video, nextTags: string[]) => {
      const before = video.user_tags;
      let saved: string[];
      try {
        saved = await api.setVideoTags(video.id, nextTags);
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      setVideos((prev) =>
        prev.map((v) => (v.id === video.id ? { ...v, user_tags: saved } : v))
      );
      // Only record an undo if something actually changed.
      const changed =
        before.length !== saved.length ||
        before.some((t, i) => t !== saved[i]);
      if (!changed) return;
      recordUndo(`Updated tags on “${video.title.slice(0, 40)}”`, async () => {
        const back = await api.setVideoTags(video.id, before);
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, user_tags: back } : v))
        );
      });
    },
    [pushToast, recordUndo]
  );

  const handleFollowChannelFromVideo = useCallback(
    async (video: Video) => {
      const channelUrl = video.channel_url;
      if (!channelUrl) return;
      // Show the same in-progress indicator as adding a link by paste: a global
      // "Following …" row, plus a local busy state on the button itself.
      const pendId = uid();
      setPending((p) => [
        ...p,
        { id: pendId, url: video.uploader ?? channelUrl, kind: "channel" },
      ]);
      setFollowingUrls((s) => new Set(s).add(channelUrl));
      try {
        const ch = await api.followChannel(channelUrl);
        setChannels((prev) => {
          const without = prev.filter((c) => c.id !== ch.id);
          return [...without, ch].sort((a, b) => a.name.localeCompare(b.name));
        });
        refreshInbox();
        recordUndo(`Followed ${ch.name}`, async () => {
          await api.unfollowChannel(ch.id);
          setChannels((prev) => prev.filter((c) => c.id !== ch.id));
          refreshInbox();
        });
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
      } finally {
        setPending((p) => p.filter((x) => x.id !== pendId));
        setFollowingUrls((s) => {
          const next = new Set(s);
          next.delete(channelUrl);
          return next;
        });
      }
    },
    [pushToast, recordUndo, refreshInbox]
  );

  const handleUnfollow = useCallback(
    async (channelId: number) => {
      const ch = channels.find((c) => c.id === channelId);
      if (!ch) return;
      try {
        await api.unfollowChannel(channelId);
      } catch (e) {
        pushToast({ kind: "err", text: `Couldn't unfollow: ${e}` });
        return;
      }
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      if (filter.kind === "channel" && filter.channelId === channelId) {
        setFilter({ kind: "all" });
      }
      refreshInbox();
      recordUndo(`Unfollowed ${ch.name}`, async () => {
        const restored = await api.followChannel(ch.url);
        setChannels((prev) => {
          const without = prev.filter((c) => c.id !== restored.id);
          return [...without, restored].sort((a, b) => a.name.localeCompare(b.name));
        });
        refreshInbox();
      });
    },
    [channels, filter, pushToast, recordUndo, refreshInbox]
  );

  const handleAddFromInbox = useCallback(
    async (cv: ChannelVideo) => {
      // Optimistically remove the row from the inbox view immediately — the
      // `in_library` filter (`!cv.in_library && !cv.dismissed`) makes it
      // disappear without waiting for the yt-dlp full-fetch to come back.
      setInbox((prev) =>
        prev.map((it) => (it.id === cv.id ? { ...it, in_library: true } : it))
      );
      // Show a "Fetching …" tracker at the top of the library list so the
      // user can see the add is in progress.
      const pendId = uid();
      setPending((p) => [...p, { id: pendId, url: cv.title, kind: "video" }]);

      let added: Video;
      try {
        added = await api.addInboxToLibrary(cv.id);
      } catch (e) {
        // Roll back the optimistic inbox hide.
        setInbox((prev) =>
          prev.map((it) => (it.id === cv.id ? { ...it, in_library: false } : it))
        );
        setPending((p) => p.filter((x) => x.id !== pendId));
        pushToast({ kind: "err", text: String(e) });
        return;
      }

      if (settings.autoFavorite && !added.favorite) {
        try {
          await api.setFavorite(added.id, true);
          added = { ...added, favorite: true };
        } catch {
          /* non-fatal */
        }
      }
      insertVideoLocally(added);
      setPending((p) => p.filter((x) => x.id !== pendId));
      refreshChannelsList();
      recordUndo(`Added “${added.title.slice(0, 50)}” to list`, async () => {
        await api.deleteVideo(added.id);
        await api.undismissInbox(cv.id);
        removeVideoLocally(added.id);
        refreshInbox();
        refreshChannelsList();
      });
    },
    [
      insertVideoLocally,
      pushToast,
      recordUndo,
      refreshChannelsList,
      refreshInbox,
      removeVideoLocally,
      settings.autoFavorite,
    ]
  );

  const handleDismissInboxItem = useCallback(
    async (cv: ChannelVideo) => {
      try {
        await api.dismissInbox(cv.id);
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      setInbox((prev) => prev.map((it) => (it.id === cv.id ? { ...it, dismissed: true } : it)));
      refreshChannelsList();
      recordUndo(`Dismissed “${cv.title.slice(0, 50)}”`, async () => {
        await api.undismissInbox(cv.id);
        setInbox((prev) => prev.map((it) => (it.id === cv.id ? { ...it, dismissed: false } : it)));
        refreshChannelsList();
      });
    },
    [pushToast, recordUndo, refreshChannelsList]
  );

  const handleOpenInboxItem = useCallback(
    async (cv: ChannelVideo) => {
      api.openVideoInBrowser(cv.url);
      // The item stays in the inbox — we just mark it as viewed so the NEW
      // badge clears and the sidebar counts decrement. User still has the
      // explicit Add / Dismiss choices.
      if (cv.seen_at != null) return; // already seen
      try {
        await api.markInboxSeen(cv.id);
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      setInbox((prev) =>
        prev.map((it) =>
          it.id === cv.id ? { ...it, seen_at: Math.floor(Date.now() / 1000) } : it
        )
      );
      refreshChannelsList();
      recordUndo(`Marked “${cv.title.slice(0, 50)}” unviewed`, async () => {
        await api.markInboxUnseen(cv.id);
        setInbox((prev) =>
          prev.map((it) => (it.id === cv.id ? { ...it, seen_at: null } : it))
        );
        refreshChannelsList();
      });
    },
    [pushToast, recordUndo, refreshChannelsList]
  );

  // ---------------------------------------------------------------------------
  // Drag-drop, paste, keyboard
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const isInAppDrag = (e: DragEvent) => {
      // Row drags carry our custom MIMEs (HTML5 paths) — but native
      // file-promise drags from our own rows look like external URL drags to
      // the webview, so also consult the draggingVideo flag, which is set for
      // every in-app row drag. The "Drop URL to add" overlay is only for
      // genuinely external drags (URLs from a browser, etc.).
      if (draggingVideoRef.current) return true;
      const types = Array.from(e.dataTransfer?.types || []);
      return types.includes(DRAG_MIME) || types.includes(INBOX_DRAG_MIME);
    };
    const isInboxRowDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types || []).includes(INBOX_DRAG_MIME);
    const onDragEnter = (e: DragEvent) => {
      if (isInAppDrag(e)) return;
      // Always prevent default for external drags — if we don't, WKWebView will
      // navigate to or render whatever is dropped (images, HTML, files, etc.).
      e.preventDefault();
      const types = Array.from(e.dataTransfer?.types || []);
      const hasUrl = types.some((t) => t === "text/uri-list" || t === "text/plain");
      if (hasUrl) {
        dragDepth.current += 1;
        setDragHover(true);
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (isInAppDrag(e)) {
        // If an inner drop target (tag folder, sidebar slot) already claimed
        // this event, leave its dropEffect alone. Otherwise we MUST cancel
        // the default ourselves: an unhandled URL drop makes WKWebView
        // NAVIGATE to the dragged URL, hijacking the whole app.
        if (!e.defaultPrevented) {
          e.preventDefault();
          // Inbox/channel rows may be dropped anywhere in the window to add
          // them; other in-app drags show the no-drop cursor here.
          if (e.dataTransfer)
            e.dataTransfer.dropEffect = isInboxRowDrag(e) ? "copy" : "none";
        }
        return;
      }
      // Always prevent default — any unhandled external drag lets WKWebView
      // take over and navigate/display the content inline.
      e.preventDefault();
      const types = Array.from(e.dataTransfer?.types || []);
      const hasUrl = types.some((t) => t === "text/uri-list" || t === "text/plain");
      if (e.dataTransfer) e.dataTransfer.dropEffect = hasUrl ? "copy" : "none";
    };
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragHover(false);
    };
    const onDrop = (e: DragEvent) => {
      // Always prevent default first — never let WKWebView handle any drop.
      e.preventDefault();
      if (isInAppDrag(e) && !isInboxRowDrag(e)) {
        // Sidebar drop targets have already handled their own drops by now.
        // Swallow everything else to block WKWebView navigation.
        return;
      }
      // A sidebar tag node handles its own URL drops (ingest + auto-tag).
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-url-drop-target="true"]')) {
        dragDepth.current = 0;
        setDragHover(false);
        return;
      }
      dragDepth.current = 0;
      setDragHover(false);
      const url = extractUrlFromDrop(e);
      if (url) {
        ingest(url);
        return;
      }
      // Show a helpful message for common non-URL drops (images, files, etc.)
      const types = Array.from(e.dataTransfer?.types || []);
      const isFileOrImage =
        types.includes("Files") || types.some((t) => t.startsWith("image/"));
      pushToast({
        kind: "err",
        text: isFileOrImage
          ? "VidMinder only accepts YouTube URLs — drag a video link here, not an image or file"
          : "Drop a YouTube video or channel URL to add it",
      });
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [ingest, pushToast]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        ingest(text);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [ingest]);

  // OS-level URL drops onto the app icon (Dock on macOS, taskbar on Windows
  // for pinned apps, launcher on Linux best-effort). `onOpenUrl` fires
  // whenever the OS hands us a URL while we're running; `getCurrent` returns
  // any URLs the OS handed us at launch (e.g. cold-launch from a dock drop).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { onOpenUrl, getCurrent } = await import(
        "@tauri-apps/plugin-deep-link"
      );
      const fn = await onOpenUrl((urls) => {
        for (const u of urls) ingest(u);
      });
      if (cancelled) fn();
      else unlisten = fn;
      const initial = await getCurrent();
      if (initial && !cancelled) for (const u of initial) ingest(u);
    })().catch(() => {
      // Plugin missing or no permission — non-fatal, drag-on-icon just won't
      // work in this build.
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [ingest]);

  const selectedVideos = useMemo(
    () => videos.filter((v) => selectedIds.has(v.id)),
    [videos, selectedIds]
  );
  const selectedVideo = selectedVideos.length === 1 ? selectedVideos[0] : null;

  // The channel-feed video backing the inbox details panel. Derived from the
  // live inbox array so its in_library / dismissed state stays current; resolves
  // to null once the item leaves the inbox entirely.
  const selectedInbox = useMemo(
    () =>
      selectedInboxId == null
        ? null
        : inbox.find((cv) => cv.id === selectedInboxId) ?? null,
    [selectedInboxId, inbox]
  );

  // Decide what a row click does based on modifier keys. `orderedIds` is the
  // current visible ordering (matters for shift-click range selects).
  const handleVideoSelect = useCallback(
    (
      video: Video,
      e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
      orderedIds: number[]
    ) => {
      if (e.shiftKey && anchorId !== null) {
        const aIdx = orderedIds.indexOf(anchorId);
        const bIdx = orderedIds.indexOf(video.id);
        if (aIdx >= 0 && bIdx >= 0) {
          const [s, t] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
          setSelectedIds(new Set(orderedIds.slice(s, t + 1)));
          // Don't move anchor — keeps shift-clicking around the same pivot.
        }
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(video.id)) next.delete(video.id);
          else next.add(video.id);
          return next;
        });
        setAnchorId(video.id);
        return;
      }
      selectSingle(video.id);
      openMobileDetails();
    },
    [anchorId, selectSingle, openMobileDetails]
  );

  // Shift-drag selection: on shift+mousedown we mark a drag anchor, and as the
  // pointer enters subsequent rows (with the button still pressed) we extend
  // the range from the drag anchor to that row.
  const handleVideoMouseDown = useCallback(
    (video: Video, e: React.MouseEvent, orderedIds: number[]) => {
      if (!e.shiftKey) return;
      if (e.button !== 0) return;
      // Don't preventDefault — we still want the click handler to fire on mouseup.
      dragRangeAnchor.current = anchorId ?? video.id;
      if (anchorId == null) {
        setAnchorId(video.id);
      }
      // Seed the range so the very first row is selected immediately.
      const aIdx = orderedIds.indexOf(dragRangeAnchor.current);
      const bIdx = orderedIds.indexOf(video.id);
      if (aIdx >= 0 && bIdx >= 0) {
        const [s, t] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
        setSelectedIds(new Set(orderedIds.slice(s, t + 1)));
      }
    },
    [anchorId]
  );

  const handleVideoMouseEnter = useCallback(
    (video: Video, e: React.MouseEvent, orderedIds: number[]) => {
      if (dragRangeAnchor.current == null) return;
      if ((e.buttons & 1) === 0) {
        dragRangeAnchor.current = null;
        return;
      }
      const aIdx = orderedIds.indexOf(dragRangeAnchor.current);
      const bIdx = orderedIds.indexOf(video.id);
      if (aIdx < 0 || bIdx < 0) return;
      const [s, t] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
      setSelectedIds(new Set(orderedIds.slice(s, t + 1)));
    },
    []
  );

  useEffect(() => {
    const onUp = () => {
      dragRangeAnchor.current = null;
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);

      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((cur) => !cur);
        return;
      }

      if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (meta && (e.key === "t" || e.key === "T") && !e.shiftKey) {
        // ⌘T focuses the tag input for the currently selected video.
        if (!selectedVideo) return;
        e.preventDefault();
        const el = document.getElementById("vidminder-tag-input");
        if (el instanceof HTMLInputElement) {
          el.focus();
          el.select();
        } else {
          // The details panel may be hidden behind a non-library filter.
          // Drop the user back to the library so the details panel is visible,
          // then focus on the next tick once the input mounts.
          setFilter({ kind: "all" });
          requestAnimationFrame(() => {
            const again = document.getElementById("vidminder-tag-input");
            if (again instanceof HTMLInputElement) {
              again.focus();
              again.select();
            }
          });
        }
        return;
      }

      if (meta && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        if (inField) return;
        e.preventDefault();
        undoLast();
        return;
      }

      // ⌘A / Ctrl+A selects every row in the current view. Inside a text
      // field the browser's own select-all must keep working.
      if (meta && (e.key === "a" || e.key === "A") && !e.shiftKey) {
        if (inField) return;
        const visible = filteredRef.current;
        if (visible.length === 0) return;
        e.preventDefault();
        setSelectedIds(new Set(visible.map((v) => v.id)));
        return;
      }

      // ⌘/Ctrl+Delete (or Backspace) deletes the active tag folder — the tag and
      // all its sub-tags, from every video. Undoable via the toast / ⌘Z.
      if (meta && (e.key === "Delete" || e.key === "Backspace")) {
        if (inField) return;
        if (filter.kind === "tag") {
          e.preventDefault();
          handleDeleteTag(filter.name);
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (e.metaKey || e.ctrlKey || e.altKey || inField) return;
        if (selectedVideos.length === 0) return;
        e.preventDefault();
        handleDeleteVideos(selectedVideos);
      }

      if (e.key === "Escape" && !inField && selectedIds.size > 0) {
        e.preventDefault();
        clearSelection();
      }

      // Enter on a single selected video opens it on YouTube.
      if (
        e.key === "Enter" &&
        !inField &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !settingsOpen &&
        !searchOpen &&
        selectedVideo
      ) {
        e.preventDefault();
        handleOpenAndMarkWatched(selectedVideo);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clearSelection,
    filter,
    handleDeleteTag,
    handleDeleteVideos,
    handleOpenAndMarkWatched,
    selectedIds,
    selectedVideo,
    selectedVideos,
    settingsOpen,
    searchOpen,
    undoLast,
  ]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  // Surface only the sort options relevant to the current context, and fall
  // back to that context's default when the stored mode doesn't apply (e.g.
  // "Date added" while viewing a channel) — without clobbering the user's
  // library preference.
  const sortOptions = useMemo(() => sortOptionsFor(filter.kind), [filter.kind]);
  const effectiveSortMode: SortMode = sortOptions.includes(sortMode)
    ? sortMode
    : sortOptions[0];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = videos.filter((v) => {
      // In channel views, hide Shorts unless the preference is on. In all other
      // library views, directly-added Shorts are always shown.
      if (v.is_short && !settings.showShorts && filter.kind === "channel") return false;
      switch (filter.kind) {
        case "all":
          break;
        case "favorites":
          if (!v.favorite) return false;
          break;
        case "inbox":
          return false;
        case "watched":
          if (!v.watched) return false;
          break;
        case "unwatched":
          if (v.watched) return false;
          break;
        case "downloaded":
          if (v.offline_status !== "ready") return false;
          break;
        case "tag": {
          // Inclusive (Calibre-style): selecting "science" matches videos
          // tagged "science" or any descendant ("science.biology", etc.).
          // The backend tag canonicalization preserves case, so plain string
          // equality / startsWith is correct here.
          const prefix = `${filter.name}.`;
          const hit = v.user_tags.some(
            (t) => t === filter.name || t.startsWith(prefix)
          );
          if (!hit) return false;
          break;
        }
        case "category":
          if (v.category !== filter.name) return false;
          break;
        case "channel": {
          const ch = channels.find((c) => c.id === filter.channelId);
          if (!ch) return false;
          const sameUrl = v.channel_url && v.channel_url === ch.url;
          const sameId = v.channel_id && ch.channel_id && v.channel_id === ch.channel_id;
          const sameName = !!v.uploader && v.uploader === ch.name;
          if (!sameUrl && !sameId && !sameName) return false;
          break;
        }
      }
      if (!q) return true;
      const hay = [
        v.title,
        v.uploader ?? "",
        v.description ?? "",
        v.category ?? "",
        v.user_tags.join(" "),
        v.raw_tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    // Sort. "added" = newest-added first (added_at). "uploaded" = newest
    // YouTube upload first (upload_date YYYYMMDD as an integer; videos with
    // no upload date sink to the bottom, then tiebreak by added_at).
    const uploadKey = (v: Video): number =>
      v.upload_date && /^\d{8}/.test(v.upload_date)
        ? parseInt(v.upload_date.slice(0, 8), 10)
        : 0;
    if (effectiveSortMode === "uploaded") {
      matched.sort((a, b) => uploadKey(b) - uploadKey(a) || b.added_at - a.added_at);
    } else if (effectiveSortMode === "length") {
      // Longest first; videos with no known duration sink to the bottom.
      matched.sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1) || b.added_at - a.added_at);
    } else {
      matched.sort((a, b) => b.added_at - a.added_at);
    }
    // Comparators above are all newest/longest-first (desc); flip for asc.
    if (sortDir === "asc") matched.reverse();
    return matched;
  }, [videos, channels, filter, search, effectiveSortMode, sortDir, settings.showShorts]);
  filteredRef.current = filtered;

  // Every distinct full dotted tag currently in use. Powers the tag editor's
  // nesting-aware autocomplete (Calibre-style).
  const allKnownTags = useMemo(() => {
    const s = new Set<string>();
    for (const v of videos) for (const t of v.user_tags) s.add(t);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [videos]);

  const visibleInboxItems = useMemo(
    () =>
      inbox.filter(
        (cv) =>
          !cv.in_library &&
          !cv.dismissed &&
          (settings.showShorts || !cv.is_short)
      ),
    [inbox, settings.showShorts]
  );

  const searchedInboxItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleInboxItems;
    return visibleInboxItems.filter((cv) => {
      const hay = [cv.title, cv.channel_name, cv.upload_date ?? ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [visibleInboxItems, search]);

  // The per-channel feed list. Built straight from `inbox` (not from the
  // global `searchedInboxItems`, which always drops in-library videos) so we
  // can intercalate already-added uploads when the "separate" preference is
  // off. Each in-library row carries its `in_library` flag for the badge.
  const channelInboxItems = useMemo(() => {
    if (filter.kind !== "channel") return [];
    const q = search.trim().toLowerCase();
    const items = inbox.filter((cv) => {
      if (cv.channel_id !== filter.channelId) return false;
      // Dismissal hides a row from the inbox, but an in-library video still
      // belongs in the channel lineup (badged) — e.g. one auto-dismissed at
      // follow time and added later by URL.
      if (cv.dismissed && !cv.in_library) return false;
      if (!settings.showShorts && cv.is_short) return false;
      // Added videos are intercalated by default; the preference pulls them
      // back out into the separate "In your list" section below.
      if (settings.separateAddedInChannels && cv.in_library) return false;
      if (q) {
        const hay = [cv.title, cv.channel_name, cv.upload_date ?? ""]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return sortChannelVideos(items, effectiveSortMode, sortDir);
  }, [
    filter,
    inbox,
    search,
    settings.showShorts,
    settings.separateAddedInChannels,
    effectiveSortMode,
    sortDir,
  ]);

  // Library videos to show in the standalone "In your list" section of a
  // channel view. When intercalating (default), only videos with no channel
  // feed row remain here (everything else is already shown, badged, above);
  // when separating, the section holds every added video for the channel.
  const channelLibraryExtras = useMemo(() => {
    if (filter.kind !== "channel") return filtered;
    if (settings.separateAddedInChannels) return filtered;
    // Match by URL *or* YouTube video id — the library stores yt-dlp's
    // canonical URL (e.g. /shorts/<id>), which can differ from the feed row's
    // watch URL; URL equality alone would list such videos twice.
    const shownUrls = new Set(channelInboxItems.map((cv) => cv.url));
    const shownIds = new Set(channelInboxItems.map((cv) => cv.video_external_id));
    return filtered.filter(
      (v) => !shownUrls.has(v.url) && !(v.video_id && shownIds.has(v.video_id))
    );
  }, [filter, filtered, channelInboxItems, settings.separateAddedInChannels]);

  const channelInboxGrouped = useMemo(() => {
    if (channelInboxItems.length === 0)
      return [] as { label: string; items: typeof channelInboxItems }[];
    // The default "Upload date" view keeps the recency buckets (Today / This
    // week / …). Any other sort (e.g. Length) wants a single globally-sorted
    // list — channelInboxItems is already ordered by the active mode.
    if (effectiveSortMode !== "uploaded") {
      const label = effectiveSortMode === "length" ? "Longest first" : SORT_LABELS[effectiveSortMode];
      return [{ label, items: channelInboxItems }];
    }
    const m = new Map<(typeof RECENCY_ORDER)[number], typeof channelInboxItems>();
    for (const cv of channelInboxItems) {
      const b = recencyBucket(cv.upload_date, cv.first_seen_at, cv.upload_timestamp);
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(cv);
    }
    return RECENCY_ORDER.flatMap((b) => {
      const arr = m.get(b);
      return arr && arr.length > 0 ? [{ label: RECENCY_LABELS[b], items: arr }] : [];
    });
  }, [channelInboxItems, effectiveSortMode]);

  const [inboxBusy, setInboxBusy] = useState<Set<number>>(new Set());

  const wrapInbox = (cv: ChannelVideo, action: (cv: ChannelVideo) => Promise<void> | void) => async () => {
    setInboxBusy((prev) => new Set(prev).add(cv.id));
    try {
      await action(cv);
    } finally {
      setInboxBusy((prev) => {
        const next = new Set(prev);
        next.delete(cv.id);
        return next;
      });
    }
  };

  // The sidebar badge counts items that are unseen, recent, and actionable.
  // Matches the SQL in `db::list_channels.inbox_count` so the per-channel
  // badges and the top-level inbox badge agree.
  const inboxCount = useMemo(
    () =>
      visibleInboxItems.filter(
        (cv) =>
          !cv.is_short &&
          cv.seen_at == null &&
          recencyBucket(cv.upload_date, cv.first_seen_at, cv.upload_timestamp) !==
            "older"
      ).length,
    [visibleInboxItems]
  );

  const currentChannel = useMemo(() => {
    if (filter.kind !== "channel") return null;
    return channels.find((c) => c.id === filter.channelId) ?? null;
  }, [channels, filter]);

  // How many library videos belong to the currently-viewed channel (same match
  // as the "channel" filter: by url, external id, or uploader name).
  const currentChannelLibraryCount = useMemo(() => {
    const ch = currentChannel;
    if (!ch) return 0;
    return videos.filter((v) => {
      const sameUrl = v.channel_url && v.channel_url === ch.url;
      const sameId = v.channel_id && ch.channel_id && v.channel_id === ch.channel_id;
      const sameName = !!v.uploader && v.uploader === ch.name;
      return sameUrl || sameId || sameName;
    }).length;
  }, [currentChannel, videos]);

  const handleSetChannelCategory = useCallback(
    async (channelId: number, category: string | null) => {
      const before = channels.find((c) => c.id === channelId)?.category ?? null;
      if (before === category) return;
      try {
        await api.setChannelCategory(channelId, category);
      } catch (e) {
        pushToast({ kind: "err", text: `Couldn't update category: ${e}` });
        return;
      }
      setChannels((prev) =>
        prev
          .map((c) => (c.id === channelId ? { ...c, category } : c))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      recordUndo(
        category ? `Set category to “${category}”` : "Cleared category",
        async () => {
          await api.setChannelCategory(channelId, before);
          setChannels((prev) =>
            prev
              .map((c) => (c.id === channelId ? { ...c, category: before } : c))
              .sort((a, b) => a.name.localeCompare(b.name))
          );
        }
      );
    },
    [channels, pushToast, recordUndo]
  );

  // ---------------------------------------------------------------------------
  // Top-of-app handlers
  // ---------------------------------------------------------------------------

  const handleResurfaceChannel = useCallback(
    async (channelId: number) => {
      const ch = channels.find((c) => c.id === channelId);
      if (!ch) return;
      if (resurfacingChannelId !== null) return; // guard against re-entry
      setResurfacingChannelId(channelId);
      const start = Date.now();
      try {
        const summary = await api.catchUpChannel(channelId);
        if (summary.surfaced > 0) {
          pushToast({
            kind: "ok",
            text: `Resurfaced ${summary.surfaced} ${summary.surfaced === 1 ? "upload" : "uploads"} from ${ch.name}`,
          });
          // Stay in the current channel view — the user came here to see this
          // channel's content; resurfaced items now show up in the channel's
          // "new uploads" sections at the top of the same view.
        } else {
          pushToast({
            kind: "ok",
            text: `${ch.name} has nothing in the last 2 weeks`,
          });
        }
        refreshInbox();
        refreshChannelsList();
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
      } finally {
        // Hold the busy state briefly so the button doesn't strobe when the
        // call returns very quickly.
        const elapsed = Date.now() - start;
        const minHoldMs = 450;
        if (elapsed < minHoldMs) {
          await new Promise((r) => setTimeout(r, minHoldMs - elapsed));
        }
        setResurfacingChannelId(null);
      }
    },
    [channels, pushToast, refreshChannelsList, refreshInbox, resurfacingChannelId]
  );

  const handleDismissManyInbox = useCallback(
    async (cvs: ChannelVideo[], label: string, scope: string) => {
      const ids = cvs.map((cv) => cv.id);
      if (ids.length === 0) return;
      if (bulkDismissingScope !== null) return;
      setBulkDismissingScope(scope);
      const start = Date.now();
      try {
        await api.dismissInboxMany(ids);
        setInbox((prev) =>
          prev.map((it) => (ids.includes(it.id) ? { ...it, dismissed: true } : it))
        );
        refreshChannelsList();
        recordUndo(`Dismissed ${ids.length} from ${label}`, async () => {
          await api.undismissInboxMany(ids);
          setInbox((prev) =>
            prev.map((it) => (ids.includes(it.id) ? { ...it, dismissed: false } : it))
          );
          refreshChannelsList();
        });
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
      } finally {
        const elapsed = Date.now() - start;
        const minHoldMs = 450;
        if (elapsed < minHoldMs) {
          await new Promise((r) => setTimeout(r, minHoldMs - elapsed));
        }
        setBulkDismissingScope(null);
      }
    },
    [bulkDismissingScope, pushToast, recordUndo, refreshChannelsList]
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      const summary = await api.refreshChannels();
      if (summary.new_videos > 0) {
        pushToast({
          kind: "ok",
          text: `${summary.new_videos} new ${summary.new_videos === 1 ? "video" : "videos"} in your inbox`,
        });
      } else if (summary.checked === 0) {
        pushToast({ kind: "ok", text: "No channels followed yet" });
      } else {
        pushToast({
          kind: "ok",
          text: `Checked ${summary.checked} ${summary.checked === 1 ? "channel" : "channels"} — nothing new`,
        });
      }
      if (summary.errors.length > 0) {
        pushToast({
          kind: "err",
          text: `${summary.errors.length} channel${summary.errors.length === 1 ? "" : "s"} failed to refresh`,
        });
      }
    } catch (e) {
      pushToast({ kind: "err", text: String(e) });
    } finally {
      // Hold the "Checking…" state for a minimum window so the button doesn't
      // visually flicker when the refresh comes back almost instantly (no
      // channels, cache hit, network error).
      const elapsed = Date.now() - start;
      const minHoldMs = 550;
      if (elapsed < minHoldMs) {
        await new Promise((r) => setTimeout(r, minHoldMs - elapsed));
      }
      setRefreshing(false);
    }
  };

  const submitAdd = () => {
    const url = addInput.trim();
    if (!url) return;
    ingest(url);
    setAddInput("");
    setAddOpen(false);
  };

  const submitFollow = () => {
    const url = followInput.trim();
    if (!url) return;
    ingest(url, { explicitChannel: true });
    setFollowInput("");
    setFollowOpen(false);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // The selection-driven details panel, shared between the desktop right-hand
  // column (lg+) and the mobile bottom sheet (below lg).
  const selectionDetailsPane =
    selectedVideos.length > 1 ? (
      <MultiVideoDetails
        videos={selectedVideos}
        allTags={allKnownTags}
        onSetWatched={handleSetWatchedMany}
        onSetFavorite={handleSetFavoriteMany}
        onAddTag={handleAddTagMany}
        onRemoveTag={handleRemoveTagMany}
        onDeleteAll={handleDeleteVideos}
        onClearSelection={clearSelection}
        defaultMaxHeight={settings.offlineMaxHeight}
        onBatchDownload={handleBatchDownload}
        onBatchRemoveDownloads={handleBatchRemoveDownloads}
      />
    ) : selectedVideo ? (
      <VideoDetails
        video={selectedVideo}
        followedChannels={channels}
        allTags={allKnownTags}
        onSetTags={handleSetTags}
        onToggleWatched={handleToggleWatched}
        onToggleFavorite={handleToggleFavorite}
        onOpen={handleOpenAndMarkWatched}
        onRequestDelete={() => handleDeleteVideo(selectedVideo)}
        onFollowChannel={handleFollowChannelFromVideo}
        followBusy={
          !!selectedVideo.channel_url &&
          followingUrls.has(selectedVideo.channel_url)
        }
        offlinePercent={downloads.get(selectedVideo.id)}
        defaultMaxHeight={settings.offlineMaxHeight}
        onDownload={(v, h) => handleDownloadVideo(v.id, h)}
        onCancelDownload={(v) => handleCancelDownload(v.id)}
        onPlayOffline={handlePlayOffline}
        onDeleteOffline={(v) => handleDeleteOffline(v.id)}
      />
    ) : selectedInbox ? (
      <ChannelVideoDetails
        cv={selectedInbox}
        busy={inboxBusy.has(selectedInbox.id)}
        onAdd={() => handleAddFromInbox(selectedInbox)}
        onDismiss={() => handleDismissInboxItem(selectedInbox)}
        onOpen={() => handleOpenInboxItem(selectedInbox)}
      />
    ) : null;

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex flex-1 min-h-0">
        {/* Below md the sidebar lives in a slide-in drawer behind the ☰
            button; at md+ the wrapper goes static and renders exactly the
            fixed column it always was. */}
        {mobileNavOpen && (
          <div
            className="fixed inset-0 z-[65] bg-black/45 md:hidden"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        <div
          className={
            "h-full fixed inset-y-0 left-0 z-[70] transition-transform duration-200 shadow-2xl " +
            "md:static md:z-auto md:translate-x-0 md:shadow-none " +
            (mobileNavOpen ? "translate-x-0" : "-translate-x-full")
          }
        >
        <Sidebar
          videos={videos}
          channels={channels}
          inboxCount={inboxCount}
          filter={filter}
          onFilter={(f) => {
            setFilter(f);
            setMobileNavOpen(false);
          }}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          onFollowClick={() => {
            setFollowOpen((x) => !x);
            setMobileNavOpen(false);
          }}
          draggingVideo={draggingVideo}
          onDropToTag={(id, tag) => {
            const v = videos.find((x) => x.id === id);
            if (v) handleAddTag(v, tag);
          }}
          onDropUrlToTag={handleDropUrlToTag}
          onRenameTag={handleRenameTag}
          onDeleteTag={handleDeleteTag}
          onDropToFavorites={(id) => {
            const v = videos.find((x) => x.id === id);
            if (v && !v.favorite) handleToggleFavorite(v);
          }}
          onDropToWatched={(id) => {
            const v = videos.find((x) => x.id === id);
            if (v && !v.watched) handleToggleWatched(v);
          }}
          onDropToUnwatched={(id) => {
            const v = videos.find((x) => x.id === id);
            if (v && v.watched) handleToggleWatched(v);
          }}
          onChannelCategoryChange={async (channelId, category) => {
            const before = channels.find((c) => c.id === channelId)?.category ?? null;
            if (before === category) return;
            try {
              await api.setChannelCategory(channelId, category);
            } catch (e) {
              pushToast({ kind: "err", text: `Couldn't update category: ${e}` });
              return;
            }
            setChannels((prev) =>
              prev
                .map((c) => (c.id === channelId ? { ...c, category } : c))
                .sort((a, b) => a.name.localeCompare(b.name))
            );
            recordUndo(
              category
                ? `Categorised channel as “${category}”`
                : "Cleared channel category",
              async () => {
                await api.setChannelCategory(channelId, before);
                setChannels((prev) =>
                  prev
                    .map((c) => (c.id === channelId ? { ...c, category: before } : c))
                    .sort((a, b) => a.name.localeCompare(b.name))
                );
              }
            );
          }}
          onOpenSettings={() => {
            setSettingsOpen(true);
            setMobileNavOpen(false);
          }}
        />
        </div>

        <main className="flex-1 min-w-0 flex flex-col">
          <header className="h-12 shrink-0 border-b border-line bg-surface flex items-center px-3 md:px-4 gap-2 md:gap-3">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="md:hidden relative shrink-0 w-8 h-8 rounded-md text-ink-dim hover:text-ink hover:bg-surface-2 transition flex items-center justify-center text-[17px]"
              title="Open navigation"
              aria-label="Open navigation"
            >
              ☰
              {inboxCount > 0 && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent" />
              )}
            </button>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                filter.kind === "inbox"
                  ? "Search inbox by title, channel, or date…"
                  : "Search title, description, uploader, tags…"
              }
              className="flex-1 min-w-0 max-w-xl text-[13px] px-3 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
            />
            <div className="text-[11.5px] text-ink-faint hidden md:block">
              {kbd("K")} search · {kbd("V")} paste · {kbd("A")} select all · {kbd("Z")} undo · Delete remove
            </div>
            {filter.kind !== "inbox" && (
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-faint shrink-0">
                <span className="hidden lg:inline">Sort</span>
                <select
                  value={effectiveSortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  className="text-[12px] px-2 py-1 rounded-md bg-canvas border border-line text-ink-dim focus:outline-none focus:border-accent"
                  title="Sort order for this list"
                >
                  {sortOptions.map((m) => (
                    <option key={m} value={m}>
                      {SORT_LABELS[m]}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                  }
                  className="self-stretch flex items-center justify-center px-2 rounded-md bg-canvas border border-line text-ink-dim hover:text-ink hover:border-line-soft focus:outline-none focus:border-accent transition"
                  title={
                    sortDir === "desc"
                      ? "Descending (greatest first) — click for ascending"
                      : "Ascending (least first) — click for descending"
                  }
                  aria-label="Toggle sort direction"
                >
                  {sortDir === "desc" ? "↓" : "↑"}
                </button>
              </label>
            )}
            <button
              onClick={() => setAddOpen((x) => !x)}
              className="text-[13px] px-3 py-1.5 rounded-md bg-accent text-black hover:brightness-110 transition shrink-0"
            >
              + Add<span className="hidden sm:inline"> URL</span>
            </button>
          </header>

          {addOpen && (
            <div className="border-b border-line bg-surface px-4 py-2.5 flex gap-2">
              <input
                autoFocus
                type="text"
                value={addInput}
                onChange={(e) => setAddInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitAdd();
                  if (e.key === "Escape") {
                    setAddInput("");
                    setAddOpen(false);
                  }
                }}
                placeholder="Video URL, channel URL, @handle, or channel ID"
                className="flex-1 text-[13px] px-3 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
              />
              <button
                onClick={submitAdd}
                className="text-[13px] px-3 rounded-md bg-surface-2 hover:bg-line"
              >
                Add
              </button>
            </div>
          )}

          {followOpen && (
            <div className="border-b border-line bg-surface px-4 py-2.5 flex gap-2">
              <input
                autoFocus
                type="text"
                value={followInput}
                onChange={(e) => setFollowInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitFollow();
                  if (e.key === "Escape") {
                    setFollowInput("");
                    setFollowOpen(false);
                  }
                }}
                placeholder="Channel URL, @handle, or just a channel name"
                className="flex-1 text-[13px] px-3 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
              />
              <button
                onClick={submitFollow}
                className="text-[13px] px-3 rounded-md bg-accent text-black hover:brightness-110"
              >
                Follow
              </button>
            </div>
          )}

          {filter.kind === "channel" && currentChannel && (
            <div className="shrink-0 border-b border-line bg-surface px-4 py-2 flex flex-wrap items-center gap-3 gap-y-1">
              {currentChannel.thumbnail_url && (
                <img
                  src={currentChannel.thumbnail_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  draggable={false}
                  className="w-6 h-6 rounded-full object-cover"
                />
              )}
              <div className="text-[13px] flex-1 truncate">
                <button
                  onClick={() => api.openInBrowser(currentChannel.url)}
                  className="font-semibold hover:text-accent hover:underline transition-colors"
                  title={`Open ${currentChannel.name} on YouTube`}
                >
                  {currentChannel.name}
                </button>
                <span className="ml-2 text-[11.5px] text-ink-faint">
                  {currentChannel.inbox_count > 0
                    ? `${currentChannel.inbox_count} new in inbox`
                    : "no new uploads"}
                </span>
              </div>
              {/* Where already-added videos sit in the feed: intercalated by
                  date (badged) or pulled out into the "In your list" section.
                  Same preference as the Settings toggle, surfaced here. */}
              <div
                className="flex items-center gap-1.5"
                title='Show videos already in your list mixed into the feed by date, or separated into their own "In your list" section'
              >
                <span className="text-[11px] text-ink-faint">Saved videos:</span>
                <div className="flex items-center rounded-md border border-line overflow-hidden">
                {([
                  { separate: false, label: "In feed" },
                  { separate: true, label: "Own section" },
                ] as const).map(({ separate, label }) => (
                  <button
                    key={label}
                    onClick={() =>
                      updateSettings({ separateAddedInChannels: separate })
                    }
                    className={
                      "text-[11px] px-2 py-1 transition " +
                      (settings.separateAddedInChannels === separate
                        ? "bg-surface-2 text-ink font-medium"
                        : "text-ink-faint hover:text-ink")
                    }
                  >
                    {label}
                  </button>
                ))}
                </div>
              </div>
              <button
                onClick={() => handleResurfaceChannel(currentChannel.id)}
                disabled={resurfacingChannelId !== null}
                className={
                  "text-[11.5px] transition inline-flex items-center gap-1.5 " +
                  (resurfacingChannelId === currentChannel.id
                    ? "text-accent cursor-default"
                    : resurfacingChannelId !== null
                    ? "text-ink-faint/40 cursor-not-allowed"
                    : "text-accent hover:brightness-125")
                }
                title="Re-check this channel and bring every upload from the last 2 weeks back into the inbox — even ones you dismissed"
              >
                {resurfacingChannelId === currentChannel.id && (
                  <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                )}
                <span>
                  {resurfacingChannelId === currentChannel.id
                    ? "Resurfacing…"
                    : "Resurface recent"}
                </span>
              </button>
              {(() => {
                const channelInbox = inbox.filter(
                  (cv) =>
                    cv.channel_id === currentChannel.id &&
                    !cv.in_library &&
                    !cv.dismissed &&
                    (settings.showShorts || !cv.is_short)
                );
                const scope = `channel-${currentChannel.id}`;
                const busy = bulkDismissingScope === scope;
                return (
                  <button
                    onClick={() => {
                      if (channelInbox.length === 0) return;
                      if (
                        !confirm(
                          `Dismiss all ${channelInbox.length} new ${channelInbox.length === 1 ? "video" : "videos"} from ${currentChannel.name}?`
                        )
                      )
                        return;
                      handleDismissManyInbox(channelInbox, currentChannel.name, scope);
                    }}
                    disabled={
                      bulkDismissingScope !== null || channelInbox.length === 0
                    }
                    className={
                      "text-[11.5px] transition inline-flex items-center gap-1.5 " +
                      (busy
                        ? "text-ink-dim cursor-default"
                        : bulkDismissingScope !== null || channelInbox.length === 0
                        ? "text-ink-faint/40 cursor-not-allowed"
                        : "text-ink-faint hover:text-ink")
                    }
                    title="Dismiss every new inbox item from this channel"
                  >
                    {busy && (
                      <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-ink-dim border-t-transparent animate-spin" />
                    )}
                    <span>{busy ? "Dismissing…" : "Dismiss all"}</span>
                  </button>
                );
              })()}
              <button
                onClick={() => handleUnfollow(currentChannel.id)}
                className="text-[11.5px] text-ink-faint hover:text-danger transition"
              >
                Unfollow
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 flex">
            <section className="flex-1 min-w-0 overflow-y-auto">
              {pending.length > 0 && (
                <div className="px-3 pt-2 space-y-1">
                  {pending.map((p) => (
                    <div
                      key={p.id}
                      className="text-[12px] text-ink-dim px-3 py-2 rounded-md bg-surface border border-line flex items-center gap-2"
                    >
                      <span className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-accent/85">
                        {p.kind === "channel" ? "Following" : "Adding"}
                      </span>
                      <span className="truncate">{p.url}</span>
                    </div>
                  ))}
                </div>
              )}

              {filter.kind === "inbox" ? (
                <InboxView
                  items={searchedInboxItems}
                  totalItems={visibleInboxItems.length}
                  channels={channels}
                  searchQuery={search}
                  onClearSearch={() => setSearch("")}
                  onAdd={handleAddFromInbox}
                  onDismiss={handleDismissInboxItem}
                  onOpen={handleOpenInboxItem}
                  onDismissAll={() => {
                    const items = visibleInboxItems;
                    if (items.length === 0) return;
                    if (!confirm(`Dismiss all ${items.length} ${items.length === 1 ? "item" : "items"} in your inbox?`))
                      return;
                    handleDismissManyInbox(items, "inbox", "inbox-global");
                  }}
                  dismissingAll={bulkDismissingScope === "inbox-global"}
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                  onDragStateChange={setDraggingVideo}
                />
              ) : filter.kind === "channel" &&
                (channelLibraryExtras.length > 0 || channelInboxItems.length > 0) ? (
                <div>
                  {channelInboxGrouped.map(({ label, items }) => (
                    <section key={"inbox-" + label} className="mb-4">
                      <div className="sticky top-0 z-[5] bg-canvas/95 backdrop-blur px-5 py-2 flex items-baseline justify-between border-b border-line/60">
                        <div className="flex items-baseline gap-3">
                          <h3 className="text-[13px] font-semibold tracking-tight">
                            {label}
                          </h3>
                          <span className="text-[11px] text-ink-faint tabular-nums">
                            {items.length}
                          </span>
                        </div>
                        <span className="text-[11px] text-ink-faint hidden sm:block">
                          {settings.separateAddedInChannels
                            ? "New from this channel"
                            : "Uploads from this channel"}
                        </span>
                      </div>
                      <div className="px-5 pt-3 space-y-2">
                        {items.map((cv) => (
                          // Wrapper carries the id the SearchPalette pick path
                          // scrolls to (`#inbox-row-<cv.id>`). Keep the wrapper
                          // outside InboxRow so the row internals stay agnostic.
                          <div key={cv.id} id={`inbox-row-${cv.id}`}>
                            <InboxRow
                              cv={cv}
                              busy={inboxBusy.has(cv.id)}
                              showChannelName={false}
                              selected={selectedInboxId === cv.id}
                              onSelect={() => handleInboxSelect(cv)}
                              onAdd={wrapInbox(cv, handleAddFromInbox)}
                              onDismiss={wrapInbox(cv, handleDismissInboxItem)}
                              onOpen={() => handleOpenInboxItem(cv)}
                              onDragStateChange={setDraggingVideo}
                            />
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                  {channelLibraryExtras.length > 0 && (
                    <section className="mb-4">
                      <div className="sticky top-0 z-[5] bg-canvas/95 backdrop-blur px-5 py-2 flex items-baseline justify-between border-b border-line/60">
                        <div className="flex items-baseline gap-3">
                          <h3 className="text-[13px] font-semibold tracking-tight">
                            In your list
                          </h3>
                          <span className="text-[11px] text-ink-faint tabular-nums">
                            {channelLibraryExtras.length}
                          </span>
                        </div>
                      </div>
                      <ul className="py-1">
                        {channelLibraryExtras.map((v) => (
                          <li key={v.id} id={`video-row-${v.id}`}>
                            <VideoCard
                              video={v}
                              selected={selectedIds.has(v.id)}
                              onSelect={(e) =>
                                handleVideoSelect(v, e, channelLibraryExtras.map((x) => x.id))
                              }
                              onMouseDownRow={(e) =>
                                handleVideoMouseDown(v, e, channelLibraryExtras.map((x) => x.id))
                              }
                              onMouseEnterRow={(e) =>
                                handleVideoMouseEnter(v, e, channelLibraryExtras.map((x) => x.id))
                              }
                              onOpen={() => handleCardOpen(v)}
                              onToggleFavorite={() => handleToggleFavorite(v)}
                              onDragStateChange={setDraggingVideo}
                              offlinePercent={downloads.get(v.id)}
                              onDownloadDefault={() =>
                                handleDownloadVideo(v.id, settings.offlineMaxHeight)
                              }
                              onCancelDownload={() => handleCancelDownload(v.id)}
                              onPlayOffline={() => handlePlayOffline(v)}
                              onRequestQualityMenu={(x, y) =>
                                setQualityMenu({
                                  videoId: v.id,
                                  status: v.offline_status,
                                  x,
                                  y,
                                })
                              }
                              onRequestContextMenu={(x, y) =>
                                setCardMenu({ video: v, x, y })
                              }
                              onNativeFileDrag={
                                !isWeb && (isMac || v.offline_status === "ready")
                                  ? () => handleNativeFileDrag(v)
                                  : undefined
                              }
                              onDragOutExport={() =>
                                handleDragOutExport(v)
                              }
                              onExportFile={
                                !isWeb
                                  ? () => handleExportVideo(v)
                                  : undefined
                              }
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              ) : filtered.length === 0 && pending.length === 0 ? (
                <EmptyState
                  totalVideos={videos.length}
                  filter={filter}
                  search={search}
                  channel={currentChannel}
                  inboxCount={inboxCount}
                  onGoInbox={() => setFilter({ kind: "inbox" })}
                  onClearSearch={() => setSearch("")}
                />
              ) : (
                <ul className="py-2">
                  {filtered.map((v) => (
                    <li key={v.id} id={`video-row-${v.id}`}>
                      <VideoCard
                        video={v}
                        selected={selectedIds.has(v.id)}
                        onSelect={(e) =>
                          handleVideoSelect(v, e, filtered.map((x) => x.id))
                        }
                        onMouseDownRow={(e) =>
                          handleVideoMouseDown(v, e, filtered.map((x) => x.id))
                        }
                        onMouseEnterRow={(e) =>
                          handleVideoMouseEnter(v, e, filtered.map((x) => x.id))
                        }
                        onOpen={() => handleCardOpen(v)}
                        onToggleFavorite={() => handleToggleFavorite(v)}
                        onDragStateChange={setDraggingVideo}
                        offlinePercent={downloads.get(v.id)}
                        onDownloadDefault={() =>
                          handleDownloadVideo(v.id, settings.offlineMaxHeight)
                        }
                        onCancelDownload={() => handleCancelDownload(v.id)}
                        onPlayOffline={() => handlePlayOffline(v)}
                        onRequestQualityMenu={(x, y) =>
                          setQualityMenu({
                            videoId: v.id,
                            status: v.offline_status,
                            x,
                            y,
                          })
                        }
                        onRequestContextMenu={(x, y) =>
                          setCardMenu({ video: v, x, y })
                        }
                        onNativeFileDrag={
                          !isWeb && (isMac || v.offline_status === "ready")
                            ? () => handleNativeFileDrag(v)
                            : undefined
                        }
                        onDragOutExport={() => handleDragOutExport(v)}
                        // No export on the web: without this gate the button
                        // still renders invisibly (opacity-0) and an
                        // accidental tap on the row edge throws.
                        onExportFile={
                          !isWeb ? () => handleExportVideo(v) : undefined
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {filter.kind !== "inbox" && (
              <div className="w-[360px] shrink-0 hidden lg:flex">
                {selectionDetailsPane ? (
                  <div className="w-full">{selectionDetailsPane}</div>
                ) : filter.kind === "channel" && currentChannel ? (
                  <div className="w-full">
                    <ChannelDetails
                      channel={currentChannel}
                      libraryCount={currentChannelLibraryCount}
                      catchingUp={resurfacingChannelId === currentChannel.id}
                      onOpenOnYouTube={() => api.openInBrowser(currentChannel.url)}
                      onCatchUp={() => handleResurfaceChannel(currentChannel.id)}
                      onUnfollow={() => handleUnfollow(currentChannel.id)}
                      onSetCategory={(cat) =>
                        handleSetChannelCategory(currentChannel.id, cat)
                      }
                    />
                  </div>
                ) : (
                  <div className="w-full h-full border-l border-line bg-surface flex items-center justify-center text-[12.5px] text-ink-faint px-6 text-center">
                    Click a video to edit it. {shiftClick} to select a range, {kbdClick()} to toggle individual videos. {kbd("Z")} undoes any change · Delete removes the selection.
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Below lg there is no right-hand details column; the same panel rides
          in a bottom sheet that opens when a row is tapped. */}
      {mobileDetailsOpen && filter.kind !== "inbox" && selectionDetailsPane && (
        <div
          className="fixed inset-0 z-[60] lg:hidden flex flex-col bg-black/45"
          onClick={() => setMobileDetailsOpen(false)}
        >
          <div
            className="mt-auto w-full max-h-[85vh] flex flex-col rounded-t-xl border-t border-line bg-surface shadow-2xl overflow-hidden pb-[env(safe-area-inset-bottom)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 flex items-center justify-between pl-4 pr-2 py-1.5 border-b border-line">
              <span className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-faint">
                {selectedVideos.length > 1
                  ? `${selectedVideos.length} selected`
                  : "Details"}
              </span>
              <button
                onClick={() => setMobileDetailsOpen(false)}
                className="w-8 h-8 rounded-md text-ink-faint hover:text-ink hover:bg-surface-2 transition"
                title="Close"
                aria-label="Close details"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 min-h-0">{selectionDetailsPane}</div>
          </div>
        </div>
      )}

      {dragHover && (
        <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center bg-canvas/85 backdrop-blur-sm">
          <div className="px-10 py-8 rounded-2xl border-2 border-dashed border-accent text-center">
            <div className="text-[20px] font-semibold mb-1">Drop URL to add</div>
            <div className="text-[13px] text-ink-dim">
              Video URLs go to your list · channel URLs start following
            </div>
          </div>
        </div>
      )}

      {qualityMenu && (
        <DownloadQualityMenu
          x={qualityMenu.x}
          y={qualityMenu.y}
          videoId={qualityMenu.videoId}
          status={qualityMenu.status}
          onPick={(h) => handleDownloadVideo(qualityMenu.videoId, h)}
          onClear={() => {
            if (qualityMenu.status === "downloading")
              handleCancelDownload(qualityMenu.videoId);
            else handleDeleteOffline(qualityMenu.videoId);
          }}
          onClose={() => setQualityMenu(null)}
        />
      )}

      {cardMenu && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          items={videoMenuItems(cardMenu.video)}
          onClose={() => setCardMenu(null)}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
        onOpenAbout={() => {
          setSettingsOpen(false);
          setAboutOpen(true);
        }}
      />

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      <SearchPalette
        open={searchOpen}
        videos={videos}
        channelVideos={inbox}
        onClose={() => setSearchOpen(false)}
        onPick={(pick) => {
          setSearch("");
          if (pick.kind === "library") {
            // Library hit: route to All Videos so the row is guaranteed visible
            // regardless of the user's current filter (tag, channel,
            // favorites, etc.). Then select + scroll.
            if (filter.kind !== "all") setFilter({ kind: "all" });
            selectSingle(pick.video.id);
            requestAnimationFrame(() => {
              const el = document.getElementById(`video-row-${pick.video.id}`);
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          } else {
            // Channel-inbox hit: switch to the parent channel's filter so the
            // "New from this channel" section is the focal view, then scroll
            // to the inbox row. setTimeout lets the new filter's DOM mount
            // before we try to find the row (rAF alone fires too early when
            // the filter switch causes a fresh InboxView render).
            const cv = pick.cv;
            setFilter({ kind: "channel", channelId: cv.channel_id });
            setTimeout(() => {
              const el = document.getElementById(`inbox-row-${cv.id}`);
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 80);
          }
        }}
      />

      <div className="toast-stack fixed bottom-3 right-3 z-40 flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "text-[12.5px] px-3 py-2 rounded-md shadow-lg border pointer-events-auto flex items-center gap-3 " +
              (t.kind === "err"
                ? "bg-surface-2 border-danger/40 text-ink"
                : "bg-surface-2 border-accent-dim text-ink")
            }
          >
            <span className="flex-1">{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.onClick();
                }}
                className="text-[12px] font-semibold uppercase tracking-wider text-accent hover:brightness-125"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({
  totalVideos,
  filter,
  search,
  channel,
  inboxCount,
  onGoInbox,
  onClearSearch,
}: {
  totalVideos: number;
  filter: Filter;
  search: string;
  channel: Channel | null;
  inboxCount: number;
  onGoInbox: () => void;
  onClearSearch: () => void;
}) {
  if (totalVideos === 0 && filter.kind === "all" && !search) {
    return (
      <div className="h-full flex items-center justify-center text-center px-6">
        <div>
          <div className="text-[18px] font-semibold mb-2">Your library is empty</div>
          <div className="text-[13px] text-ink-dim max-w-md leading-relaxed">
            Drag a video URL from your browser's address bar onto this window, paste one with {kbd("V")}, or click{" "}
            <span className="text-accent">+ Add URL</span>. Channel URLs (e.g.{" "}
            <code className="text-ink">youtube.com/@SomeChannel</code>) start following the channel instead.
          </div>
        </div>
      </div>
    );
  }

  const q = search.trim();

  if (filter.kind === "channel" && channel) {
    if (q) {
      return (
        <CenteredEmpty
          title={`No matches in ${channel.name}`}
          body={`Nothing in your list from ${channel.name} matches “${q}”.`}
          action={{ label: "Clear search", onClick: onClearSearch }}
        />
      );
    }
    return (
      <CenteredEmpty
        title={`Nothing from ${channel.name} in your list yet`}
        body={
          inboxCount > 0
            ? `New uploads from this channel land in your Inbox first — there ${inboxCount === 1 ? "is" : "are"} ${inboxCount} waiting.`
            : `You're following this channel — new uploads land in your Inbox automatically (checked every 30 min). Add any to your list from there.`
        }
        action={
          inboxCount > 0
            ? { label: "Open inbox", onClick: onGoInbox }
            : undefined
        }
      />
    );
  }

  if (filter.kind === "favorites") {
    if (q) {
      return (
        <CenteredEmpty
          title="No favorites match your search"
          body={`Nothing starred matches “${q}”.`}
          action={{ label: "Clear search", onClick: onClearSearch }}
        />
      );
    }
    return (
      <CenteredEmpty
        title="No favorites yet"
        body="Hover a video and tap the ★ on its thumbnail, or use the star button in the details panel. Anything you star will live here."
      />
    );
  }

  if (filter.kind === "watched") {
    return (
      <CenteredEmpty
        title="Nothing watched yet"
        body="Once you mark videos as watched, they'll appear here. Use the “Mark watched” button in any video's details."
      />
    );
  }

  if (filter.kind === "unwatched") {
    return (
      <CenteredEmpty
        title="All caught up"
        body="No unwatched videos in your list."
      />
    );
  }

  if (filter.kind === "downloaded") {
    return (
      <CenteredEmpty
        title="Nothing downloaded yet"
        body="Hover a video and tap the download button on its thumbnail (or right-click it to pick a resolution). Downloaded videos for offline viewing show up here."
      />
    );
  }

  if (filter.kind === "tag") {
    return (
      <CenteredEmpty
        title={`No videos tagged #${filter.name}`}
        body={
          q
            ? `Nothing tagged #${filter.name} matches “${q}”.`
            : `Add #${filter.name} to a video from its details panel to see it here.`
        }
        action={q ? { label: "Clear search", onClick: onClearSearch } : undefined}
      />
    );
  }

  if (filter.kind === "category") {
    return (
      <CenteredEmpty
        title={`No videos in “${filter.name}”`}
        body={
          q
            ? `Nothing in this category matches “${q}”.`
            : `This category came from a video's metadata — none currently match.`
        }
        action={q ? { label: "Clear search", onClick: onClearSearch } : undefined}
      />
    );
  }

  // "all" + search
  if (q) {
    return (
      <CenteredEmpty
        title="No matches"
        body={`Nothing in your list matches “${q}”.`}
        action={{ label: "Clear search", onClick: onClearSearch }}
      />
    );
  }

  return <CenteredEmpty title="Nothing here" body="" />;
}

function CenteredEmpty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="h-full flex items-center justify-center text-center px-6">
      <div className="max-w-md">
        <div className="text-[15px] font-semibold mb-1.5">{title}</div>
        {body && (
          <div className="text-[12.5px] text-ink-dim leading-relaxed">
            {body}
          </div>
        )}
        {action && (
          <button
            onClick={action.onClick}
            className="mt-4 text-[12.5px] px-3 py-1.5 rounded-md bg-accent text-black hover:brightness-110 transition"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

export default App;
