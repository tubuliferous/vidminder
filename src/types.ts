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
  folder: string | null;
  user_tags: string[];
  watched: boolean;
  favorite: boolean;
  added_at: number;
  channel_url: string | null;
  channel_id: string | null;
};

export type Channel = {
  id: number;
  url: string;
  source: string;
  channel_id: string | null;
  name: string;
  thumbnail_url: string | null;
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

export type Filter =
  | { kind: "all" }
  | { kind: "inbox" }
  | { kind: "favorites" }
  | { kind: "unwatched" }
  | { kind: "watched" }
  | { kind: "tag"; name: string }
  | { kind: "folder"; name: string }
  | { kind: "category"; name: string }
  | { kind: "source"; name: string }
  | { kind: "channel"; channelId: number };
