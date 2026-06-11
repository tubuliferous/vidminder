/// Shared drag-image rendering for row drags (library cards and inbox rows).
///
/// Why this exists: WKWebView's auto-generated drag snapshots are unreliable —
/// a stray text selection composites a "ghost" of other rows' text into the
/// drag image, and snapshots differ between drag paths. So every row drag —
/// HTML5 (`setDragImage`) and native (tauri-plugin-drag) — uses the same
/// pre-rendered PNG of just the row: thumbnail, title, subtitle, themed to
/// match the current light/dark interface.
///
/// Images are rendered lazily on row hover and cached per (theme, key), so
/// they're ready synchronously by the time a drag starts.

export type RowLook = {
  title: string;
  subtitle: string;
  thumbnailUrl: string | null;
};

export type RowDragImage = {
  /// PNG data URL — handed to the native drag plugin.
  dataUrl: string;
  /// Pre-loaded image element — handed to HTML5 setDragImage.
  img: HTMLImageElement;
};

const resolved = new Map<string, RowDragImage>();
const inflight = new Map<string, Promise<RowDragImage>>();

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

/// Load a thumbnail with CORS enabled so it can be drawn to a canvas without
/// tainting it. Resolves null on error/timeout — we fall back to a placeholder.
function loadCorsImage(
  src: string,
  timeoutMs: number
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const t = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(t);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
    img.src = src;
  });
}

const W = 320;
const H = 76;

function draw(
  look: RowLook,
  theme: "light" | "dark",
  thumb: HTMLImageElement | null
): string {
  const c =
    theme === "light"
      ? {
          bg: "#ffffff",
          border: "rgba(0,0,0,0.22)",
          thumbBox: "#e9e9ef",
          glyph: "rgba(0,0,0,0.40)",
          title: "rgba(0,0,0,0.88)",
          meta: "rgba(0,0,0,0.50)",
        }
      : {
          bg: "#16161e",
          border: "rgba(255,255,255,0.16)",
          thumbBox: "#2a2a36",
          glyph: "rgba(255,255,255,0.45)",
          title: "rgba(255,255,255,0.92)",
          meta: "rgba(255,255,255,0.50)",
        };
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = c.border;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  // Thumbnail box (16:9, left side)
  const tw = 112;
  const th = 63;
  const tx = 7;
  const ty = (H - th) / 2;
  ctx.fillStyle = c.thumbBox;
  ctx.fillRect(tx, ty, tw, th);
  if (thumb) {
    try {
      // Cover-fit crop
      const scale = Math.max(tw / thumb.width, th / thumb.height);
      const sw = tw / scale;
      const sh = th / scale;
      ctx.drawImage(
        thumb,
        (thumb.width - sw) / 2,
        (thumb.height - sh) / 2,
        sw,
        sh,
        tx,
        ty,
        tw,
        th
      );
    } catch {
      /* keep the placeholder box */
    }
  } else {
    ctx.fillStyle = c.glyph;
    ctx.font = "20px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("▶", tx + tw / 2, ty + th / 2);
  }
  // Title: up to two lines, ellipsized.
  const textX = tx + tw + 10;
  const maxW = W - textX - 8;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = "600 13px system-ui";
  ctx.fillStyle = c.title;
  const words = look.title.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const probe = cur ? cur + " " + w : w;
    if (ctx.measureText(probe).width > maxW && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === 2) break;
    } else {
      cur = probe;
    }
  }
  if (lines.length < 2 && cur) lines.push(cur);
  if (lines.length === 2 && cur && lines[1] !== cur) {
    let last = lines[1];
    while (ctx.measureText(last + "…").width > maxW && last.length > 1)
      last = last.slice(0, -1);
    lines[1] = last + "…";
  }
  lines.forEach((ln, i) => ctx.fillText(ln, textX, 28 + i * 17));
  ctx.font = "11.5px system-ui";
  ctx.fillStyle = c.meta;
  ctx.fillText(look.subtitle, textX, H - 14);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return ""; // tainted (shouldn't happen with crossOrigin) — caller retries
  }
}

async function render(look: RowLook, theme: "light" | "dark"): Promise<RowDragImage> {
  let dataUrl = "";
  if (look.thumbnailUrl) {
    const thumb = await loadCorsImage(look.thumbnailUrl, 350);
    dataUrl = draw(look, theme, thumb);
  }
  if (!dataUrl) dataUrl = draw(look, theme, null);
  const img = new Image();
  await new Promise<void>((res) => {
    img.onload = () => res();
    img.onerror = () => res();
    img.src = dataUrl;
  });
  return { dataUrl, img };
}

/// Render (or fetch from cache) the drag image for a row. Call on row hover so
/// the image is ready by the time a drag starts; the native drag path awaits
/// the result directly.
export function ensureRowDragImage(
  key: string,
  look: RowLook
): Promise<RowDragImage> {
  const k = `${currentTheme()}:${key}`;
  const hit = resolved.get(k);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = render(look, currentTheme()).then((entry) => {
      resolved.set(k, entry);
      inflight.delete(k);
      return entry;
    });
    inflight.set(k, p);
  }
  return p;
}

/// Synchronous cache lookup, for use inside dragstart handlers.
export function cachedRowDragImage(key: string): RowDragImage | null {
  return resolved.get(`${currentTheme()}:${key}`) ?? null;
}
