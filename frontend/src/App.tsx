import { useState } from "react";

/**
 * App shell placeholder (FRONTEND.md task U0).
 * The canvas editor (U1–U4) and sim bridge (U5) replace the placeholder body.
 */
export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  return (
    <div className="app" data-theme={theme}>
      <header className="app-header">
        <h1>CircuitSim++</h1>
        <div className="header-actions">
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light" : "Dark"} theme
          </button>
        </div>
      </header>
      <main className="app-canvas-placeholder">
        <p>
          Circuit canvas goes here (task U1). Palette themes are CSS custom properties — see
          styles.css.
        </p>
        <div className="wire-demo" aria-hidden="true">
          <span className="wire wire-low" />
          <span className="wire wire-high" />
          <span className="wire wire-bus-a" />
          <span className="wire wire-bus-b" />
        </div>
      </main>
      <footer className="app-statusbar">Idle — no circuit loaded</footer>
    </div>
  );
}
