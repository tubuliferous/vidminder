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

// yt-dlp upload_date is YYYYMMDD; render it in a calendar-friendly way.
// `style: "short"` omits the year when it matches the current year.
export function formatUploadDate(
  raw: string | null | undefined,
  style: "short" | "full" = "full"
): string {
  if (!raw || raw.length < 8) return "";
  const y = parseInt(raw.slice(0, 4), 10);
  const m = parseInt(raw.slice(4, 6), 10);
  const d = parseInt(raw.slice(6, 8), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return "";
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return "";
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

export type RecencyBucket = "today" | "thisWeek" | "thisMonth" | "older";

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
  today: "Today",
  thisWeek: "This week",
  thisMonth: "This month",
  older: "Earlier",
};

export const RECENCY_ORDER: RecencyBucket[] = ["today", "thisWeek", "thisMonth", "older"];

export function recencyBucket(
  uploadDate: string | null,
  firstSeenAt: number,
  uploadTimestamp?: number | null
): RecencyBucket {
  let uploadMs: number;
  if (uploadTimestamp && uploadTimestamp > 0) {
    uploadMs = uploadTimestamp * 1000;
  } else if (uploadDate && /^\d{8}/.test(uploadDate)) {
    const y = +uploadDate.slice(0, 4);
    const m = +uploadDate.slice(4, 6);
    const d = +uploadDate.slice(6, 8);
    uploadMs = new Date(y, m - 1, d).getTime();
  } else {
    uploadMs = firstSeenAt * 1000;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - uploadMs) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays <= 7) return "thisWeek";
  if (diffDays <= 30) return "thisMonth";
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
