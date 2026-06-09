import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  CatchUpSummary,
  Channel,
  ChannelVideo,
  IngestResult,
  RefreshSummary,
  TagCount,
  Video,
} from "./types";
import { withAutoplay } from "./utils";

export async function addVideo(url: string): Promise<Video> {
  return await invoke<Video>("add_video", { url });
}

export async function ingestUrl(url: string): Promise<IngestResult> {
  return await invoke<IngestResult>("ingest_url", { url });
}

export async function followChannel(url: string): Promise<Channel> {
  return await invoke<Channel>("follow_channel", { url });
}

export async function unfollowChannel(id: number): Promise<void> {
  await invoke("unfollow_channel", { id });
}

export async function setChannelCategory(id: number, category: string | null): Promise<void> {
  await invoke("set_channel_category", { id, category });
}

export async function listChannels(): Promise<Channel[]> {
  return await invoke<Channel[]>("list_channels");
}

export async function listInbox(): Promise<ChannelVideo[]> {
  return await invoke<ChannelVideo[]>("list_inbox");
}

export async function dismissInbox(id: number): Promise<void> {
  await invoke("dismiss_inbox", { id });
}

export async function undismissInbox(id: number): Promise<void> {
  await invoke("undismiss_inbox", { id });
}

export async function markInboxSeen(id: number): Promise<void> {
  await invoke("mark_inbox_seen", { id });
}

export async function markInboxUnseen(id: number): Promise<void> {
  await invoke("mark_inbox_unseen", { id });
}

export async function dismissAllInbox(channelId: number): Promise<void> {
  await invoke("dismiss_all_inbox", { channelId });
}

/// Bulk dismiss — runs dismissInbox in parallel. Returns the IDs that were
/// dismissed so the caller can record an undoable batch.
export async function dismissInboxMany(ids: number[]): Promise<void> {
  await Promise.all(ids.map((id) => invoke("dismiss_inbox", { id })));
}

export async function undismissInboxMany(ids: number[]): Promise<void> {
  await Promise.all(ids.map((id) => invoke("undismiss_inbox", { id })));
}

export async function addInboxToLibrary(id: number): Promise<Video> {
  return await invoke<Video>("add_inbox_to_library", { id });
}

export async function refreshChannels(): Promise<RefreshSummary> {
  return await invoke<RefreshSummary>("refresh_channels");
}

export async function catchUpChannel(channelId: number): Promise<CatchUpSummary> {
  return await invoke<CatchUpSummary>("catch_up_channel", { channelId });
}

export async function setChannelLookbackDays(days: number): Promise<void> {
  await invoke("set_channel_lookback_days", { days });
}

export async function listVideos(): Promise<Video[]> {
  return await invoke<Video[]>("list_videos");
}

// === Offline downloads =====================================================

/// The video heights yt-dlp reports as available for this video, largest first.
export async function listVideoFormats(videoId: number): Promise<number[]> {
  return await invoke<number[]>("list_video_formats", { videoId });
}

/// Start (or no-op if already running) a download. `maxHeight` caps resolution;
/// 0 = audio-only, 99999 = best available.
export async function downloadVideo(videoId: number, maxHeight: number): Promise<void> {
  await invoke("download_video", { videoId, maxHeight });
}

/// Batch download — each video is capped at `maxHeight` (or below if it has no
/// stream that tall).
export async function downloadVideos(videoIds: number[], maxHeight: number): Promise<void> {
  await invoke("download_videos", { videoIds, maxHeight });
}

export async function cancelDownload(videoId: number): Promise<void> {
  await invoke("cancel_download", { videoId });
}

export async function deleteOffline(videoId: number): Promise<void> {
  await invoke("delete_offline", { videoId });
}

/// Open a downloaded video in the system's default media player. Returns false
/// if the file is gone (deleted outside the app) — in which case the backend
/// has reset the video's offline status and the caller should open it online.
/// Goes through a small Rust command (native `open`/`xdg-open`/`start`) rather
/// than the opener plugin, which is gated by webview capabilities.
export async function openOffline(videoId: number): Promise<boolean> {
  return await invoke<boolean>("open_offline", { videoId });
}

export async function deleteVideo(id: number): Promise<void> {
  await invoke("delete_video", { id });
}

export async function restoreVideo(video: Video): Promise<Video> {
  return await invoke<Video>("restore_video", { video });
}

export async function setWatched(id: number, watched: boolean): Promise<void> {
  await invoke("set_watched", { id, watched });
}

export async function setFavorite(id: number, favorite: boolean): Promise<void> {
  await invoke("set_favorite", { id, favorite });
}

export async function addTag(id: number, tag: string): Promise<string[]> {
  return await invoke<string[]>("add_tag", { id, tag });
}

export async function removeTag(id: number, tag: string): Promise<string[]> {
  return await invoke<string[]>("remove_tag", { id, tag });
}

export async function listTagCounts(): Promise<TagCount[]> {
  return await invoke<TagCount[]>("list_tag_counts");
}

export async function setVideoTags(id: number, tags: string[]): Promise<string[]> {
  return await invoke<string[]>("set_video_tags", { id, tags });
}

export async function addTagToVideos(videoIds: number[], tag: string): Promise<void> {
  await invoke("add_tag_to_videos", { videoIds, tag });
}

export async function renameTag(oldTag: string, newTag: string): Promise<void> {
  await invoke("rename_tag", { old: oldTag, new: newTag });
}

export async function deleteTag(tag: string): Promise<void> {
  await invoke("delete_tag", { tag });
}

export async function openInBrowser(url: string): Promise<void> {
  await openUrl(url);
}

/// Opens a video URL with autoplay tacked on for YouTube. Browsers will block
/// autoplay with sound unless the user has previously interacted with the
/// domain, but for active YouTube users it usually starts playing immediately.
export async function openVideoInBrowser(url: string): Promise<void> {
  await openUrl(withAutoplay(url));
}
