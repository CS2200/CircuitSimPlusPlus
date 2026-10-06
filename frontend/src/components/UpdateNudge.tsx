import { useEffect, useState } from "react";
import { APP_VERSION, checkForUpdate, dismiss, type UpdateInfo } from "../update";

/**
 * Update nudge dialog + About card (DESIGN.md §9, FRONTEND.md U8).
 *
 * UpdateNudge: appears once at startup when a newer GitHub release exists;
 * dismissible for that version ("don't show again" persists per version),
 * never forced, never auto-installs.
 *
 * AboutCard: version + the unsigned-build workaround text (also in the
 * release body), opened from the header.
 */

export function UpdateNudge() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((u) => {
      if (!cancelled) setInfo(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (info === null) return null;
  return (
    <div className="help-overlay">
      <div className="help-card update-nudge" role="dialog" aria-label="Update available">
        <h2>A newer CircuitSim++ is out</h2>
        <p>
          You're on <strong>{APP_VERSION}</strong>; the latest release is{" "}
          <strong>{info.latest}</strong>.
        </p>
        <p className="help-dismiss">Upgrading keeps you compatible with the autograder.</p>
        <div className="prop-actions">
          <a className="update-link" href={info.url} target="_blank" rel="noreferrer">
            Download {info.latest}
          </a>
          <button
            className="secondary"
            onClick={() => {
              dismiss(info.latest);
              setInfo(null);
            }}
          >
            Don't show again for {info.latest}
          </button>
          <button className="secondary" onClick={() => setInfo(null)}>
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

export function AboutCard({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <h2>CircuitSim++</h2>
        <p>
          Version <strong>{APP_VERSION}</strong> — the CS 2200 circuit simulator.
        </p>
        <p>
          This build is <strong>unsigned</strong>. Your OS may warn on first launch; that's
          expected. macOS: right-click → Open. Windows: SmartScreen → More info → Run anyway.
        </p>
        <p className="help-dismiss">click anywhere or press Esc to dismiss</p>
      </div>
    </div>
  );
}
