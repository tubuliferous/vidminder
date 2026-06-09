export type Video = {
  id: number;
  url: string;
  source: string;
  video_id: string | null;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  uploader: string | null;
  duration: number | null;
  upload_date: string | null;
  category: string | null;
  raw_tags: string[];
  user_tags: string[];
  watched: boolean;
  favorite: boolean;
  added_at: number;
  channel_url: string | null;
  channel_id: string | null;
  /// Offline-download state. `offline_status` is "none" | "downloading" |
  /// "ready" | "error"; the rest are populated only when status is "ready".
  offline_status: string;
  offline_path: string | null;
  offline_quality: string | null;
  offline_size: number | null;
  offline_downloaded_at: number | null;
};

export type Channel = {
  id: number;
  url: string;
  source: string;
  channel_id: string | null;
  name: string;
  thumbnail_url: string | null;
  category: string | null;
  description: string | null;
  subscriber_count: number | null;
  followed_at: number;
  last_checked_at: number | null;
  inbox_count: number;
};

export type ChannelVideo = {
  id: number;
  channel_id: number;
  channel_name: string;
  channel_url: string;
  video_external_id: string;
  url: string;
  title: string;
  thumbnail_url: string | null;
  duration: number | null;
  upload_date: string | null;
  upload_timestamp: number | null;
  first_seen_at: number;
  seen_at: number | null;
  dismissed: boolean;
  in_library: boolean;
};

export type CatchUpSummary = {
  surfaced: number;
};

export type IngestResult =
  | { kind: "video"; value: Video }
  | { kind: "channel"; value: Channel };

export type RefreshSummary = {
  checked: number;
  new_videos: number;
  errors: string[];
};

/** A distinct full dotted tag ("science.biology") with its exact video count.
 *  The sidebar builds the dotted tree + inclusive parent counts from these. */
export type TagCount = {
  tag: string;
  count: number;
};

/** Active sidebar filter. `tag` is INCLUSIVE — `tag:"science"` matches videos
 *  carrying "science" or any descendant ("science.biology", ...). */
export type Filter =
  | { kind: "all" }
  | { kind: "inbox" }
  | { kind: "favorites" }
  | { kind: "unwatched" }
  | { kind: "watched" }
  | { kind: "downloaded" }
  | { kind: "tag"; name: string }
  | { kind: "category"; name: string }
  | { kind: "channel"; channelId: number };
