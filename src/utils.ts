export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Resolve upload date from either yt-dlp's `upload_date` (YYYYMMDD string) or
// the `timestamp` field returned by --flat-playlist + approximate_date.
// Channel listings populate the timestamp but not the date string, so we need
// the fallback to display anything for inbox / channel-view rows.
// `style: "short"` omits the year when it matches the current year.
export function formatUploadDate(
  raw: string | null | undefined,
  style: "short" | "full" = "full",
  timestamp?: number | null
): string {
  let date: Date | null = null;
  if (raw && raw.length >= 8) {
    const y = parseInt(raw.slice(0, 4), 10);
    const m = parseInt(raw.slice(4, 6), 10);
    const d = parseInt(raw.slice(6, 8), 10);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      const d1 = new Date(y, m - 1, d);
      if (!Number.isNaN(d1.getTime())) date = d1;
    }
  }
  if (!date && timestamp && timestamp > 0) {
    const d2 = new Date(timestamp * 1000);
    if (!Number.isNaN(d2.getTime())) date = d2;
  }
  if (!date) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  if (style === "short" && sameYear) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatAddedAt(unixSecs: number): string {
  const ms = unixSecs * 1000;
  const now = Date.now();
  const diff = now - ms;
  const m = 60_000;
  const h = 60 * m;
  const d = 24 * h;
  if (diff < m) return "just now";
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 7 * d) return `${Math.floor(diff / d)}d ago`;
  const date = new Date(ms);
  return date.toLocaleDateString();
}

export const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function isYouTubeUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.host.toLowerCase();
    return YOUTUBE_HOSTS.has(host) || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

/// Coerce whatever the user typed into a canonical YouTube URL we can hand to
/// yt-dlp. Accepts:
///   - Full URLs (https://youtube.com/..., http://youtu.be/..., etc.)
///   - URLs missing the scheme (youtube.com/@name, youtu.be/abc)
///   - YouTube channel @handles (@SomeChannel or SomeChannel)
///   - Raw channel IDs (UCxxxxxxxxxxxxxxxxxxxxx)
/// Returns null if we can't make a YouTube URL out of it.
export function normalizeYouTubeInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already a full URL — keep if it's YouTube.
  if (/^https?:\/\//i.test(trimmed)) {
    return isYouTubeUrl(trimmed) ? trimmed : null;
  }

  // Scheme-less URL (e.g. "youtube.com/@x", "youtu.be/abc")
  if (
    /^(www\.|m\.|music\.)?youtube\.com\//i.test(trimmed) ||
    /^youtu\.be\//i.test(trimmed)
  ) {
    return "https://" + trimmed;
  }

  // @handle ("@HeatherCoxRichardson")
  if (trimmed.startsWith("@")) {
    const handle = trimmed.slice(1);
    if (/^[A-Za-z0-9._-]{1,60}$/.test(handle)) {
      return `https://www.youtube.com/@${handle}`;
    }
    return null;
  }

  // Bare channel ID — strict UC pattern
  if (/^UC[A-Za-z0-9_-]{22}$/.test(trimmed)) {
    return `https://www.youtube.com/channel/${trimmed}`;
  }

  // Bare handle-like string — no spaces, no slashes, no scheme. Treat as a
  // YouTube @ handle.
  if (/^[A-Za-z0-9._-]{1,60}$/.test(trimmed)) {
    return `https://www.youtube.com/@${trimmed}`;
  }

  return null;
}

/// Mirror of the Rust-side heuristic — does this URL look like a channel page
/// rather than a single video? Used only for labeling the pending tracker;
/// the backend makes the authoritative video-vs-channel decision.
export function looksLikeChannelUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const p = u.pathname;
      if (
        p.startsWith("/watch") ||
        p.startsWith("/shorts/") ||
        p.startsWith("/live/") ||
        p.startsWith("/embed/")
      ) {
        return false;
      }
      if (
        p.startsWith("/@") ||
        p.startsWith("/channel/") ||
        p.startsWith("/c/") ||
        p.startsWith("/user/")
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export type RecencyBucket = "today" | "thisWeek" | "lastWeek" | "older";

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
  today: "Today",
  thisWeek: "This week",
  lastWeek: "Last week",
  older: "Earlier",
};

export const RECENCY_ORDER: RecencyBucket[] = ["today", "thisWeek", "lastWeek", "older"];

export function recencyBucket(
  uploadDate: string | null,
  _firstSeenAt: number,
  uploadTimestamp?: number | null
): RecencyBucket {
  // We deliberately do NOT fall back to first_seen_at — that's when VidMinder
  // first encountered the video, not when it was actually uploaded. Without a
  // real upload time we bucket as "older" so unknown-date items don't pollute
  // the Today / Week / Month buckets.
  let uploadMs: number | null = null;
  if (uploadTimestamp && uploadTimestamp > 0) {
    uploadMs = uploadTimestamp * 1000;
  } else if (uploadDate && /^\d{8}/.test(uploadDate)) {
    const y = +uploadDate.slice(0, 4);
    const m = +uploadDate.slice(4, 6);
    const d = +uploadDate.slice(6, 8);
    uploadMs = new Date(y, m - 1, d).getTime();
  }
  if (uploadMs == null) return "older";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - uploadMs) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays <= 7) return "thisWeek";
  if (diffDays <= 14) return "lastWeek";
  return "older";
}

export function isNew(
  uploadDate: string | null,
  firstSeenAt: number,
  uploadTimestamp?: number | null
): boolean {
  return recencyBucket(uploadDate, firstSeenAt, uploadTimestamp) !== "older";
}

/// For YouTube watch URLs, append `autoplay=1` so the video plays immediately
/// when opened in the browser (subject to the browser's autoplay policy).
export function withAutoplay(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.host.toLowerCase();
    if (host === "youtu.be") {
      u.searchParams.set("autoplay", "1");
      return u.toString();
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (u.pathname.startsWith("/watch") || u.pathname.startsWith("/shorts/")) {
        u.searchParams.set("autoplay", "1");
        return u.toString();
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/// Generate a transient id (used as a React key for the pending-add tracker).
/// `crypto.randomUUID` only exists on Safari 15.4+, so on older WebKit — which
/// the Intel/Monterey builds must support — we fall back to a v4 UUID built
/// from `crypto.getRandomValues` (Safari ~6+), then to a non-crypto string.
/// These ids are never persisted or security-sensitive.
export function uid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h
      .slice(6, 8)
      .join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const DRAG_MIME = "application/x-vidminder-video";

export function extractUrlFromDrop(e: React.DragEvent | DragEvent): string | null {
  const dt = e.dataTransfer;
  if (!dt) return null;
  const uriList = dt.getData("text/uri-list");
  if (uriList) {
    const line = uriList
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (line) return line;
  }
  const text = dt.getData("text/plain");
  if (text && /^https?:\/\//i.test(text.trim())) {
    return text.trim();
  }
  return null;
}
