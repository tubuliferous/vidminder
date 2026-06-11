import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { kbd, kbdClick, shiftClick } from "../platform";

type Props = {
  open: boolean;
  onClose: () => void;
};

/// Opened from the macOS app menu's "About VidMinder" (and the Settings
/// footer on every platform): version, a quick how-to, and the full
/// keyboard-shortcut guide.
export function AboutDialog({ open, onClose }: Props) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const shortcuts: { keys: string; what: string }[] = [
    { keys: kbd("K"), what: "Search everything (library + inbox)" },
    { keys: kbd("V"), what: "Paste a URL to add the video (or follow a channel)" },
    { keys: kbd("A"), what: "Select all rows in the current view" },
    { keys: kbd("Z"), what: "Undo the last action (add, delete, tag, dismiss…)" },
    { keys: kbd("T"), what: "Focus the tag input for the selected video" },
    { keys: kbd(","), what: "Open Settings" },
    { keys: "Delete", what: "Remove the selected video(s) from the library" },
    { keys: kbd("Delete"), what: "Delete the selected tag folder" },
    { keys: "Enter", what: "Open the selected video on YouTube" },
    { keys: "Esc", what: "Clear the selection / close dialogs" },
    { keys: kbdClick(), what: "Toggle a row in and out of the selection" },
    { keys: shiftClick, what: "Extend the selection to a range" },
  ];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-16 pb-8 bg-black/45 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] max-h-[calc(100vh-6rem)] flex flex-col rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 pb-4 border-b border-line shrink-0">
          <div>
            <h2 className="text-[16px] font-semibold leading-none">
              About VidMinder
            </h2>
            <div className="text-[11.5px] text-ink-faint mt-1">
              {version ? `Version ${version} · ` : ""}Esc to close
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md text-ink-faint hover:text-ink hover:bg-surface-2 transition"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-6 text-[12.5px] leading-relaxed">
          <p className="text-ink-dim">
            A calm pool of videos you&rsquo;ll actually get to. Drop YouTube
            URLs anywhere on the window to collect them; drop a channel URL to
            follow it and get new uploads in your inbox.
          </p>

          <div className="mt-5">
            <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-2">
              The basics
            </div>
            <ul className="list-disc pl-4 space-y-1 text-ink-dim">
              <li>
                Drag videos onto sidebar tags or library slots to organize.
                Use dotted tags (&ldquo;a.b&rdquo;) for nesting.
              </li>
              <li>
                The download button on each card saves a video for offline.
                Right-click it to pick a resolution.
              </li>
              <li>
                Drag a row out of the window to export the video file to the
                Desktop or any folder — it downloads first if needed.
              </li>
              <li>
                Right-click any card for the full menu: play offline, show in
                Finder, export, watch state, and more.
              </li>
            </ul>
          </div>

          <div className="mt-5">
            <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-faint mb-2">
              Keyboard shortcuts
            </div>
            <table className="w-full">
              <tbody>
                {shortcuts.map((s) => (
                  <tr key={s.keys + s.what}>
                    <td className="py-[3px] pr-4 whitespace-nowrap align-top">
                      <span className="inline-block text-[11.5px] px-1.5 py-[1px] rounded bg-surface-2 border border-line text-ink-dim font-medium">
                        {s.keys}
                      </span>
                    </td>
                    <td className="py-[3px] text-ink-dim">{s.what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
