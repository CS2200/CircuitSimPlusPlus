import { useMemo, useState } from "react";
import CircuitCanvas from "./components/CircuitCanvas";
import { StressScene, STRESS_COMPONENT_COUNT, STRESS_WIRE_COUNT } from "./render/stressScene";

/**
 * App shell. Until U2+ lands the real document model, the canvas hosts the
 * U1 stress scene (5,000 wires + 1,500 components) as the perf harness.
 */
export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [animate, setAnimate] = useState(true);
  const scene = useMemo(() => StressScene.generate(), []);

  return (
    <div className="app" data-theme={theme}>
      <header className="app-header">
        <h1>CircuitSim++</h1>
        <div className="header-actions">
          <button onClick={() => setAnimate(!animate)}>
            {animate ? "Pause states" : "Animate states"}
          </button>
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light" : "Dark"} theme
          </button>
        </div>
      </header>
      <main className="app-canvas">
        <CircuitCanvas scene={scene} themeName={theme} animate={animate} />
      </main>
      <footer className="app-statusbar">
        U1 renderer stress scene — {STRESS_WIRE_COUNT.toLocaleString()} wires,{" "}
        {STRESS_COMPONENT_COUNT.toLocaleString()} components · drag to pan · wheel to zoom
      </footer>
    </div>
  );
}
