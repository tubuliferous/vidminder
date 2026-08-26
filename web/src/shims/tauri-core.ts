// Shim for "@tauri-apps/api/core" — `invoke` becomes a fetch to the Worker's
// command dispatcher. Offline/export commands are rejected client-side (the
// UI hides them on web via platform.isWeb, so these throws are a backstop).

const UNAVAILABLE = new Set([
  "list_video_formats",
  "download_video",
  "download_videos",
  "cancel_download",
  "delete_offline",
  "open_offline",
  "reveal_offline_file",
  "reveal_path",
  "prepare_export_file",
  "export_video_to",
  "start_export_drag",
]);

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (UNAVAILABLE.has(cmd) || cmd.startsWith("plugin:")) {
    throw "not available in the web app";
  }
  const res = await fetch(`/api/invoke/${cmd}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stripChannels(args ?? {})),
  });
  if (res.status === 401) {
    // Session expired — bounce to the login screen.
    window.location.reload();
    throw "not logged in";
  }
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* keep the status text */
    }
    // Desktop invoke rejects with the raw error string — match that.
    throw message;
  }
  return (await res.json()) as T;
}

// Tauri's Channel is used for streamed backend→frontend events (export drags).
// None of that exists on web; the class only needs to be constructible.
export class Channel<T = unknown> {
  onmessage: (message: T) => void = () => {};
}

function stripChannels(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v instanceof Channel) continue;
    out[k] = v;
  }
  return out;
}
