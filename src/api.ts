import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  CatchUpSummary,
  Channel,
  ChannelVideo,
  IngestResult,
  Playlist,
  RefreshSummary,
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

export async function listVideos(): Promise<Video[]> {
  return await invoke<Video[]>("list_videos");
}

export async function deleteVideo(id: number): Promise<void> {
  await invoke("delete_video", { id });
}

export async function restoreVideo(video: Video): Promise<Video> {
  return await invoke<Video>("restore_video", { video });
}

export async function setFolder(id: number, folder: string | null): Promise<void> {
  await invoke("set_folder", { id, folder });
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

export async function listPlaylists(): Promise<Playlist[]> {
  return await invoke<Playlist[]>("list_playlists");
}

export async function createPlaylist(name: string): Promise<Playlist> {
  return await invoke<Playlist>("create_playlist", { name });
}

export async function deletePlaylist(id: number): Promise<void> {
  await invoke("delete_playlist", { id });
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  await invoke("rename_playlist", { id, name });
}

export async function addToPlaylist(playlistId: number, videoId: number): Promise<void> {
  await invoke("add_to_playlist", { playlistId, videoId });
}

export async function removeFromPlaylist(
  playlistId: number,
  videoId: number
): Promise<void> {
  await invoke("remove_from_playlist", { playlistId, videoId });
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
