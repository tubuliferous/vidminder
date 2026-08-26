// Shims for the small Tauri modules the desktop frontend imports. Everything
// here is either a no-op or a browser-native equivalent.

// --- "@tauri-apps/api/event" ------------------------------------------------
// Backend push events (download progress, videos-changed) don't exist on web;
// the UI already reloads after every mutating action, so a no-op unlisten is
// enough.
export async function listen<T>(
  _event: string,
  _handler: (event: { payload: T }) => void
): Promise<() => void> {
  return () => {};
}

// --- "@tauri-apps/plugin-opener" ---------------------------------------------
export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener");
}

// --- "@tauri-apps/api/path" ---------------------------------------------------
export async function downloadDir(): Promise<string> {
  throw new Error("not available in the web app");
}

// --- "@tauri-apps/plugin-dialog" ----------------------------------------------
export async function save(_options?: unknown): Promise<string | null> {
  return null;
}

// --- "@tauri-apps/api/app" ------------------------------------------------------
export async function getVersion(): Promise<string> {
  return "web";
}

// --- "@tauri-apps/plugin-deep-link" ----------------------------------------------
export async function onOpenUrl(
  _handler: (urls: string[]) => void
): Promise<() => void> {
  return () => {};
}

export async function getCurrent(): Promise<string[] | null> {
  return null;
}
