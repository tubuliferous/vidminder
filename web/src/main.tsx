import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
// The desktop frontend, compiled for the browser via the Tauri shims wired up
// in vite.config.ts. Its App.css carries the Tailwind directives + theme
// tokens, so no separate stylesheet is needed here.
import App from "../../src/App";
import "../../src/App.css";
import { initThemeFromStorage } from "../../src/settings";
import { Login, type WebUser } from "./Login";

initThemeFromStorage();

function AuthGate() {
  const [user, setUser] = useState<WebUser | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<WebUser>) : null))
      .then((u) => setUser(u))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ink-faint text-sm">
        Loading…
      </div>
    );
  }
  if (user === null) return <Login onLoggedIn={setUser} />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>
);
