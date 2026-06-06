import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
import { InboxView } from "./components/InboxView";
import { InboxRow } from "./components/InboxRow";
import { SettingsDialog } from "./components/SettingsDialog";
import { SearchPalette } from "./components/SearchPalette";
import {
  DRAG_MIME,
  extractUrlFromDrop,
  looksLikeChannelUrl,
  normalizeYouTubeInput,
  recencyBucket,
  RECENCY_LABELS,
  RECENCY_ORDER,
} from "./utils";
import { useSettings } from "./settings";
import { kbd, kbdClick, shiftClick } from "./platform";

type Pending = { id: string; url: string; kind: "video" | "channel" };
type SortMode = "added" | "uploaded";
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

function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [inbox, setInbox] = useState<ChannelVideo[]>([]);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  // Multi-select. selectedIds carries the full selection; anchorId is the
  // pivot for shift-click range selects. Treat single selection as a set of
  // size 1 — the rest of the code branches on selectedIds.size.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [anchorId, setAnchorId] = useState<number | null>(null);
  // While the user is shift+mousedown-dragging through the list, this holds
  // the row they started on so each newly-entered row extends the range.
  const dragRangeAnchor = useRef<number | null>(null);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dragHover, setDragHover] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [followOpen, setFollowOpen] = useState(false);
  const [followInput, setFollowInput] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("added");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [draggingVideo, setDraggingVideo] = useState(false);
  // Per-action in-flight trackers — keep buttons disabled and showing
  // progress until the underlying async work resolves.
  const [resurfacingChannelId, setResurfacingChannelId] = useState<number | null>(null);
  const [bulkDismissingScope, setBulkDismissingScope] = useState<string | null>(null);
  const [settings, updateSettings] = useSettings();

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

  // Backend events (e.g. background polling brought in new inbox items)
  useEffect(() => {
    const ul1 = listen("videos-changed", () => refreshVideos());
    const ul2 = listen("channels-changed", () => {
      refreshChannelsList();
      refreshInbox();
    });
    const ul3 = listen("inbox-changed", () => {
      refreshInbox();
      refreshChannelsList();
    });
    return () => {
      ul1.then((f) => f());
      ul2.then((f) => f());
      ul3.then((f) => f());
    };
  }, [refreshVideos, refreshChannelsList, refreshInbox]);

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
  }, []);

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
        recordUndo(`Added “${v.title.slice(0, 50)}”`, async () => {
          await api.deleteVideo(v.id);
          removeVideoLocally(v.id);
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
      const pendId = crypto.randomUUID();
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
      recordUndo(`Removed “${target.title.slice(0, 50)}”`, async () => {
        const restored = await api.restoreVideo(target);
        insertVideoLocally(restored);
        selectSingle(restored.id);
      });
    },
    [insertVideoLocally, pushToast, recordUndo, removeVideoLocally, selectSingle]
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

  const handleSetFolderMany = useCallback(
    async (videosArr: Video[], folder: string | null) => {
      if (videosArr.length === 0) return;
      const snapshot = videosArr.map((v) => ({ id: v.id, prev: v.folder }));
      const toUpdate = videosArr.filter((v) => (v.folder ?? null) !== folder);
      if (toUpdate.length === 0) return;
      const idSet = new Set(snapshot.map((s) => s.id));
      setVideos((prev) =>
        prev.map((v) => (idSet.has(v.id) ? { ...v, folder } : v))
      );
      try {
        await Promise.all(toUpdate.map((v) => api.setFolder(v.id, folder)));
      } catch (e) {
        setVideos((prev) =>
          prev.map((v) => {
            const s = snapshot.find((s) => s.id === v.id);
            return s ? { ...v, folder: s.prev } : v;
          })
        );
        pushToast({ kind: "err", text: String(e) });
        return;
      }
      const label = folder
        ? `Set ${toUpdate.length} to folder “${folder}”`
        : `Cleared folder on ${toUpdate.length}`;
      recordUndo(label, async () => {
        await Promise.all(snapshot.map((s) => api.setFolder(s.id, s.prev)));
        setVideos((prev) =>
          prev.map((v) => {
            const s = snapshot.find((s) => s.id === v.id);
            return s ? { ...v, folder: s.prev } : v;
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

  const handleRenameTag = useCallback(
    async (oldTag: string, newTag: string) => {
      const a = oldTag.trim();
      const b = newTag.trim();
      if (!a || !b || a === b) return;
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
      pushToast({ kind: "ok", text: `Renamed “${a}” → “${b}”` });
    },
    [filter, pushToast]
  );

  const handleDeleteTag = useCallback(
    async (tag: string) => {
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
      pushToast({ kind: "ok", text: `Deleted tag “${tag}”` });
    },
    [filter, pushToast]
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
      const pendId = crypto.randomUUID();
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
          }
        );
      }
    },
    [clearSelection, handleDeleteVideo, pushToast, recordUndo]
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

  const handleSetFolder = useCallback(
    async (video: Video, folder: string | null) => {
      const previous = video.folder;
      if (previous === folder) return;
      setVideos((prev) =>
        prev.map((v) => (v.id === video.id ? { ...v, folder } : v))
      );
      try {
        await api.setFolder(video.id, folder);
      } catch (e) {
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, folder: previous } : v))
        );
        pushToast({ kind: "err", text: `Couldn't set folder: ${e}` });
        return;
      }
      recordUndo(
        folder ? `Set folder to “${folder}”` : "Cleared folder",
        async () => {
          await api.setFolder(video.id, previous);
          setVideos((prev) =>
            prev.map((v) => (v.id === video.id ? { ...v, folder: previous } : v))
          );
        }
      );
    },
    [pushToast, recordUndo]
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
      if (!video.channel_url) return;
      try {
        const ch = await api.followChannel(video.channel_url);
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
      const pendId = crypto.randomUUID();
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
      const types = Array.from(e.dataTransfer?.types || []);
      return types.includes(DRAG_MIME);
    };
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (isInAppDrag(e)) return;
      const types = Array.from(e.dataTransfer.types || []);
      if (!types.some((t) => t === "text/uri-list" || t === "text/plain")) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragHover(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (isInAppDrag(e)) return;
      const types = Array.from(e.dataTransfer.types || []);
      if (!types.some((t) => t === "text/uri-list" || t === "text/plain")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragHover(false);
    };
    const onDrop = (e: DragEvent) => {
      if (isInAppDrag(e)) {
        // Let sidebar drop targets handle it (or quietly ignore if dropped elsewhere).
        return;
      }
      // A sidebar tag node handles its own URL drops (ingest + auto-tag).
      // The React handler on the row runs before this window handler, so by
      // the time we get here it's already done — just reset overlay state.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-url-drop-target="true"]')) {
        dragDepth.current = 0;
        setDragHover(false);
        return;
      }
      e.preventDefault();
      dragDepth.current = 0;
      setDragHover(false);
      const url = extractUrlFromDrop(e);
      if (url) {
        ingest(url);
      } else {
        pushToast({ kind: "err", text: "No URL found in the drop" });
      }
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
    },
    [anchorId, selectSingle]
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
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clearSelection,
    handleDeleteVideos,
    selectedIds,
    selectedVideos,
    undoLast,
  ]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = videos.filter((v) => {
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
        case "folder":
          if (v.folder !== filter.name) return false;
          break;
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
        v.folder ?? "",
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
    if (sortMode === "uploaded") {
      matched.sort((a, b) => uploadKey(b) - uploadKey(a) || b.added_at - a.added_at);
    } else {
      matched.sort((a, b) => b.added_at - a.added_at);
    }
    return matched;
  }, [videos, channels, filter, search, sortMode]);

  const knownFolders = useMemo(() => {
    const s = new Set<string>();
    for (const v of videos) if (v.folder) s.add(v.folder);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [videos]);

  // Every distinct full dotted tag currently in use. Powers the tag editor's
  // nesting-aware autocomplete (Calibre-style).
  const allKnownTags = useMemo(() => {
    const s = new Set<string>();
    for (const v of videos) for (const t of v.user_tags) s.add(t);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [videos]);

  const visibleInboxItems = useMemo(
    () => inbox.filter((cv) => !cv.in_library && !cv.dismissed),
    [inbox]
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

  const channelInboxItems = useMemo(() => {
    if (filter.kind !== "channel") return [];
    return searchedInboxItems.filter((cv) => cv.channel_id === filter.channelId);
  }, [filter, searchedInboxItems]);

  const channelInboxGrouped = useMemo(() => {
    if (channelInboxItems.length === 0)
      return [] as { bucket: (typeof RECENCY_ORDER)[number]; items: typeof channelInboxItems }[];
    const m = new Map<(typeof RECENCY_ORDER)[number], typeof channelInboxItems>();
    for (const cv of channelInboxItems) {
      const b = recencyBucket(cv.upload_date, cv.first_seen_at, cv.upload_timestamp);
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(cv);
    }
    return RECENCY_ORDER.flatMap((b) => {
      const arr = m.get(b);
      return arr && arr.length > 0 ? [{ bucket: b, items: arr }] : [];
    });
  }, [channelInboxItems]);

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

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex flex-1 min-h-0">
        <Sidebar
          videos={videos}
          channels={channels}
          inboxCount={inboxCount}
          filter={filter}
          onFilter={setFilter}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          onFollowClick={() => setFollowOpen((x) => !x)}
          draggingVideo={draggingVideo}
          onDropToFolder={(id, folder) => {
            const v = videos.find((x) => x.id === id);
            if (v) handleSetFolder(v, folder);
          }}
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
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main className="flex-1 min-w-0 flex flex-col">
          <header className="h-12 shrink-0 border-b border-line bg-surface flex items-center px-4 gap-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                filter.kind === "inbox"
                  ? "Search inbox by title, channel, or date…"
                  : "Search title, description, uploader, tags…"
              }
              className="flex-1 max-w-xl text-[13px] px-3 py-1.5 rounded-md bg-canvas border border-line focus:outline-none focus:border-accent"
            />
            <div className="text-[11.5px] text-ink-faint hidden md:block">
              {kbd("K")} search · {kbd("V")} paste · {kbd("Z")} undo · Delete remove
            </div>
            {filter.kind !== "inbox" && (
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-faint shrink-0">
                <span className="hidden lg:inline">Sort</span>
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  className="text-[12px] px-2 py-1 rounded-md bg-canvas border border-line text-ink-dim focus:outline-none focus:border-accent"
                  title="Sort order for the library list"
                >
                  <option value="added">Date added</option>
                  <option value="uploaded">Upload date</option>
                </select>
              </label>
            )}
            <button
              onClick={() => setAddOpen((x) => !x)}
              className="text-[13px] px-3 py-1.5 rounded-md bg-accent text-black hover:brightness-110 transition shrink-0"
            >
              + Add URL
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
            <div className="shrink-0 border-b border-line bg-surface px-4 py-2 flex items-center gap-3">
              {currentChannel.thumbnail_url && (
                <img
                  src={currentChannel.thumbnail_url}
                  alt=""
                  referrerPolicy="no-referrer"
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
                    !cv.dismissed
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
                />
              ) : filter.kind === "channel" &&
                (filtered.length > 0 || channelInboxItems.length > 0) ? (
                <div>
                  {channelInboxGrouped.map(({ bucket, items }) => (
                    <section key={"inbox-" + bucket} className="mb-4">
                      <div className="sticky top-0 z-[5] bg-canvas/95 backdrop-blur px-5 py-2 flex items-baseline justify-between border-b border-line/60">
                        <div className="flex items-baseline gap-3">
                          <h3 className="text-[13px] font-semibold tracking-tight">
                            {RECENCY_LABELS[bucket]}
                          </h3>
                          <span className="text-[11px] text-ink-faint tabular-nums">
                            {items.length}
                          </span>
                        </div>
                        <span className="text-[11px] text-ink-faint hidden sm:block">
                          New from this channel
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
                              onAdd={wrapInbox(cv, handleAddFromInbox)}
                              onDismiss={wrapInbox(cv, handleDismissInboxItem)}
                              onOpen={() => handleOpenInboxItem(cv)}
                            />
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                  {filtered.length > 0 && (
                    <section className="mb-4">
                      <div className="sticky top-0 z-[5] bg-canvas/95 backdrop-blur px-5 py-2 flex items-baseline justify-between border-b border-line/60">
                        <div className="flex items-baseline gap-3">
                          <h3 className="text-[13px] font-semibold tracking-tight">
                            In your list
                          </h3>
                          <span className="text-[11px] text-ink-faint tabular-nums">
                            {filtered.length}
                          </span>
                        </div>
                      </div>
                      <ul className="py-1">
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
                              onOpen={() => handleOpenAndMarkWatched(v)}
                              onToggleFavorite={() => handleToggleFavorite(v)}
                              onDragStateChange={setDraggingVideo}
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
                        onOpen={() => handleOpenAndMarkWatched(v)}
                        onToggleFavorite={() => handleToggleFavorite(v)}
                        onDragStateChange={setDraggingVideo}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {filter.kind !== "inbox" && (
              <div className="w-[360px] shrink-0 hidden lg:flex">
                {selectedVideos.length > 1 ? (
                  <div className="w-full">
                    <MultiVideoDetails
                      videos={selectedVideos}
                      knownFolders={knownFolders}
                      allTags={allKnownTags}
                      onSetWatched={handleSetWatchedMany}
                      onSetFavorite={handleSetFavoriteMany}
                      onSetFolder={handleSetFolderMany}
                      onAddTag={handleAddTagMany}
                      onRemoveTag={handleRemoveTagMany}
                      onDeleteAll={handleDeleteVideos}
                      onClearSelection={clearSelection}
                    />
                  </div>
                ) : selectedVideo ? (
                  <div className="w-full">
                    <VideoDetails
                      video={selectedVideo}
                      knownFolders={knownFolders}
                      followedChannels={channels}
                      allTags={allKnownTags}
                      onSetTags={handleSetTags}
                      onSetFolder={handleSetFolder}
                      onToggleWatched={handleToggleWatched}
                      onToggleFavorite={handleToggleFavorite}
                      onOpen={handleOpenAndMarkWatched}
                      onRequestDelete={() => handleDeleteVideo(selectedVideo)}
                      onFollowChannel={handleFollowChannelFromVideo}
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

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />

      <SearchPalette
        open={searchOpen}
        videos={videos}
        channelVideos={inbox}
        onClose={() => setSearchOpen(false)}
        onPick={(pick) => {
          setSearch("");
          if (pick.kind === "library") {
            // Library hit: route to All Videos so the row is guaranteed visible
            // regardless of the user's current filter (tag, folder, channel,
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

      <div className="absolute bottom-3 right-3 z-40 flex flex-col gap-2 max-w-sm pointer-events-none">
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

  if (filter.kind === "folder") {
    return (
      <CenteredEmpty
        title={`Folder “${filter.name}” is empty`}
        body={
          q
            ? `Nothing in this folder matches “${q}”.`
            : `Assign a video to this folder from its details panel to see it here.`
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
