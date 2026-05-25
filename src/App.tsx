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
import { InboxView } from "./components/InboxView";
import { InboxRow } from "./components/InboxRow";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  DRAG_MIME,
  extractUrlFromDrop,
  isYouTubeUrl,
  recencyBucket,
  RECENCY_LABELS,
  RECENCY_ORDER,
} from "./utils";
import { useSettings } from "./settings";

type Pending = { id: string; url: string };
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dragHover, setDragHover] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [followOpen, setFollowOpen] = useState(false);
  const [followInput, setFollowInput] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draggingVideo, setDraggingVideo] = useState(false);
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
    setSelectedId((cur) => (cur === id ? null : cur));
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
        setSelectedId(v.id);
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
      const url = rawUrl.trim();
      if (!url) return;
      if (!isYouTubeUrl(url)) {
        pushToast({
          kind: "err",
          text: "Only YouTube URLs are supported right now",
        });
        return;
      }
      const pendId = crypto.randomUUID();
      setPending((p) => [...p, { id: pendId, url }]);
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
        setSelectedId(target.id);
        pushToast({ kind: "err", text: `Couldn't remove: ${e}` });
        return;
      }
      recordUndo(`Removed “${target.title.slice(0, 50)}”`, async () => {
        const restored = await api.restoreVideo(target);
        insertVideoLocally(restored);
        setSelectedId(restored.id);
      });
    },
    [insertVideoLocally, pushToast, recordUndo, removeVideoLocally]
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

  const handleRemoveTag = useCallback(
    async (video: Video, tag: string) => {
      let tags: string[];
      try {
        tags = await api.removeTag(video.id, tag);
      } catch (e) {
        pushToast({ kind: "err", text: `Couldn't remove tag: ${e}` });
        return;
      }
      setVideos((prev) =>
        prev.map((v) => (v.id === video.id ? { ...v, user_tags: tags } : v))
      );
      recordUndo(`Removed tag #${tag}`, async () => {
        const updated = await api.addTag(video.id, tag);
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, user_tags: updated } : v))
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
      let added: Video;
      try {
        added = await api.addInboxToLibrary(cv.id);
      } catch (e) {
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
      setInbox((prev) =>
        prev.map((it) => (it.id === cv.id ? { ...it, in_library: true } : it))
      );
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

  const handleOpenAndDismissInbox = useCallback(
    async (cv: ChannelVideo) => {
      api.openVideoInBrowser(cv.url);
      // Reuse the undoable dismiss flow so ⌘Z brings it back to the inbox.
      await handleDismissInboxItem(cv);
    },
    [handleDismissInboxItem]
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

  const selectedVideo = useMemo(
    () => videos.find((v) => v.id === selectedId) ?? null,
    [videos, selectedId]
  );

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
        if (!selectedVideo) return;
        e.preventDefault();
        handleDeleteVideo(selectedVideo);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleDeleteVideo, selectedVideo, undoLast]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return videos.filter((v) => {
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
        case "tag":
          if (!v.user_tags.includes(filter.name)) return false;
          break;
        case "folder":
          if (v.folder !== filter.name) return false;
          break;
        case "category":
          if (v.category !== filter.name) return false;
          break;
        case "source":
          if (v.source !== filter.name) return false;
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
  }, [videos, channels, filter, search]);

  const knownFolders = useMemo(() => {
    const s = new Set<string>();
    for (const v of videos) if (v.folder) s.add(v.folder);
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

  // The sidebar badge counts items released within the last month.
  const inboxCount = useMemo(
    () =>
      visibleInboxItems.filter(
        (cv) =>
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

  const handleCatchUp = useCallback(
    async (channelId: number) => {
      const ch = channels.find((c) => c.id === channelId);
      if (!ch) return;
      try {
        const summary = await api.catchUpChannel(channelId);
        if (summary.surfaced > 0) {
          pushToast({
            kind: "ok",
            text: `Surfaced ${summary.surfaced} recent ${summary.surfaced === 1 ? "upload" : "uploads"} from ${ch.name} in your inbox`,
          });
          // Hop the user to the inbox so they see what landed.
          setFilter({ kind: "inbox" });
        } else {
          pushToast({
            kind: "ok",
            text: `${ch.name} has nothing in the last 30 days`,
          });
        }
        refreshInbox();
        refreshChannelsList();
      } catch (e) {
        pushToast({ kind: "err", text: String(e) });
      }
    },
    [channels, pushToast, refreshChannelsList, refreshInbox]
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
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main className="flex-1 min-w-0 flex flex-col">
          <header className="h-12 shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface)] flex items-center px-4 gap-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                filter.kind === "inbox"
                  ? "Search inbox by title, channel, or date…"
                  : "Search title, description, uploader, tags…"
              }
              className="flex-1 max-w-xl text-[13px] px-3 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
            />
            <div className="text-[11.5px] text-[var(--color-ink-faint)] hidden md:block">
              Drop URLs · ⌘V to paste · ⌘Z to undo · Delete to remove
            </div>
            <button
              onClick={() => setAddOpen((x) => !x)}
              className="text-[13px] px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-black hover:brightness-110 transition"
            >
              + Add URL
            </button>
          </header>

          {addOpen && (
            <div className="border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5 flex gap-2">
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
                placeholder="https://www.youtube.com/watch?v=…  or  youtube.com/@SomeChannel to follow"
                className="flex-1 text-[13px] px-3 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              <button
                onClick={submitAdd}
                className="text-[13px] px-3 rounded-md bg-[var(--color-surface-2)] hover:bg-[var(--color-line)]"
              >
                Add
              </button>
            </div>
          )}

          {followOpen && (
            <div className="border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5 flex gap-2">
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
                placeholder="Paste a channel URL — e.g. youtube.com/@SomeChannel"
                className="flex-1 text-[13px] px-3 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              <button
                onClick={submitFollow}
                className="text-[13px] px-3 rounded-md bg-[var(--color-accent)] text-black hover:brightness-110"
              >
                Follow
              </button>
            </div>
          )}

          {filter.kind === "channel" && currentChannel && (
            <div className="shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2 flex items-center gap-3">
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
                  className="font-semibold hover:text-[var(--color-accent)] hover:underline transition-colors"
                  title={`Open ${currentChannel.name} on YouTube`}
                >
                  {currentChannel.name}
                </button>
                <span className="ml-2 text-[11.5px] text-[var(--color-ink-faint)]">
                  {currentChannel.inbox_count > 0
                    ? `${currentChannel.inbox_count} new in inbox`
                    : "no new uploads"}
                </span>
              </div>
              <button
                onClick={() => handleCatchUp(currentChannel.id)}
                className="text-[11.5px] text-[var(--color-accent)] hover:brightness-125 transition"
                title="Re-check this channel and surface recent uploads (last 30 days) in your inbox"
              >
                Catch me up
              </button>
              <button
                onClick={() => handleUnfollow(currentChannel.id)}
                className="text-[11.5px] text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] transition"
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
                      className="text-[12px] text-[var(--color-ink-dim)] px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-line)] flex items-center gap-2"
                    >
                      <span className="inline-block w-3 h-3 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
                      <span className="truncate">Fetching {p.url}</span>
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
                  onOpenAndDismiss={handleOpenAndDismissInbox}
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                />
              ) : filter.kind === "channel" &&
                (filtered.length > 0 || channelInboxItems.length > 0) ? (
                <div>
                  {channelInboxGrouped.map(({ bucket, items }) => (
                    <section key={"inbox-" + bucket} className="mb-4">
                      <div className="sticky top-0 z-[5] bg-[var(--color-canvas)]/95 backdrop-blur px-5 py-2 flex items-baseline justify-between border-b border-[var(--color-line)]/60">
                        <div className="flex items-baseline gap-3">
                          <h3 className="text-[13px] font-semibold tracking-tight">
                            {RECENCY_LABELS[bucket]}
                          </h3>
                          <span className="text-[11px] text-[var(--color-ink-faint)] tabular-nums">
                            {items.length}
                          </span>
                        </div>
                        <span className="text-[11px] text-[var(--color-ink-faint)] hidden sm:block">
                          New from this channel
                        </span>
                      </div>
                      <div className="px-5 pt-3 space-y-2">
                        {items.map((cv) => (
                          <InboxRow
                            key={cv.id}
                            cv={cv}
                            busy={inboxBusy.has(cv.id)}
                            showChannelName={false}
                            onAdd={wrapInbox(cv, handleAddFromInbox)}
                            onDismiss={wrapInbox(cv, handleDismissInboxItem)}
                            onOpenAndDismiss={() => handleOpenAndDismissInbox(cv)}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                  {filtered.length > 0 && (
                    <section className="mb-4">
                      <div className="sticky top-0 z-[5] bg-[var(--color-canvas)]/95 backdrop-blur px-5 py-2 flex items-baseline justify-between border-b border-[var(--color-line)]/60">
                        <div className="flex items-baseline gap-3">
                          <h3 className="text-[13px] font-semibold tracking-tight">
                            In your list
                          </h3>
                          <span className="text-[11px] text-[var(--color-ink-faint)] tabular-nums">
                            {filtered.length}
                          </span>
                        </div>
                      </div>
                      <ul className="py-1">
                        {filtered.map((v) => (
                          <li key={v.id}>
                            <VideoCard
                              video={v}
                              selected={v.id === selectedId}
                              onSelect={() => setSelectedId(v.id)}
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
                    <li key={v.id}>
                      <VideoCard
                        video={v}
                        selected={v.id === selectedId}
                        onSelect={() => setSelectedId(v.id)}
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
                {selectedVideo ? (
                  <div className="w-full">
                    <VideoDetails
                      video={selectedVideo}
                      knownFolders={knownFolders}
                      followedChannels={channels}
                      onAddTag={handleAddTag}
                      onRemoveTag={handleRemoveTag}
                      onSetFolder={handleSetFolder}
                      onToggleWatched={handleToggleWatched}
                      onToggleFavorite={handleToggleFavorite}
                      onOpen={handleOpenAndMarkWatched}
                      onRequestDelete={() => handleDeleteVideo(selectedVideo)}
                      onFollowChannel={handleFollowChannelFromVideo}
                    />
                  </div>
                ) : (
                  <div className="w-full h-full border-l border-[var(--color-line)] bg-[var(--color-surface)] flex items-center justify-center text-[12.5px] text-[var(--color-ink-faint)] px-6 text-center">
                    Select a video to edit tags, folder, or watched state. ⌘Z undoes any change · Delete removes the highlighted video.
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {dragHover && (
        <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center bg-[var(--color-canvas)]/85 backdrop-blur-sm">
          <div className="px-10 py-8 rounded-2xl border-2 border-dashed border-[var(--color-accent)] text-center">
            <div className="text-[20px] font-semibold mb-1">Drop URL to add</div>
            <div className="text-[13px] text-[var(--color-ink-dim)]">
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

      <div className="absolute bottom-3 right-3 z-40 flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "text-[12.5px] px-3 py-2 rounded-md shadow-lg border pointer-events-auto flex items-center gap-3 " +
              (t.kind === "err"
                ? "bg-[var(--color-surface-2)] border-[var(--color-danger)]/40 text-[var(--color-ink)]"
                : "bg-[var(--color-surface-2)] border-[var(--color-accent-dim)] text-[var(--color-ink)]")
            }
          >
            <span className="flex-1">{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.onClick();
                }}
                className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-accent)] hover:brightness-125"
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
          <div className="text-[13px] text-[var(--color-ink-dim)] max-w-md leading-relaxed">
            Drag a video URL from your browser's address bar onto this window, paste one with ⌘V, or click{" "}
            <span className="text-[var(--color-accent)]">+ Add URL</span>. Channel URLs (e.g.{" "}
            <code className="text-[var(--color-ink)]">youtube.com/@SomeChannel</code>) start following the channel instead.
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

  if (filter.kind === "source") {
    return (
      <CenteredEmpty
        title={`No videos from ${filter.name}`}
        body={
          q
            ? `Nothing from ${filter.name} matches “${q}”.`
            : `You haven't added any ${filter.name} videos yet.`
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
          <div className="text-[12.5px] text-[var(--color-ink-dim)] leading-relaxed">
            {body}
          </div>
        )}
        {action && (
          <button
            onClick={action.onClick}
            className="mt-4 text-[12.5px] px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-black hover:brightness-110 transition"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

export default App;
