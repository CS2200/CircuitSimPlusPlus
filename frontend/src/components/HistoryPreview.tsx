import { useCallback, useMemo } from "react";
import CanvasHost, { type CanvasHostProps } from "./CanvasHost";
import { DocScene, type SceneOverlay } from "../editor/docScene";
import { CircuitDocument } from "../model/document";
import { SelectionModel } from "../model/selection";

/**
 * Read-only render of one stored version (version history, UI_OVERHAUL §34).
 *
 * The version's canonical `.csx` is parsed into a throwaway document and drawn
 * on its OWN `DocScene`/`CanvasHost`. Nothing here touches the editor's
 * document, selection, undo history, sim session or autosave — so previewing an
 * old version can never disturb the live one, and dropping the overlay is
 * instant.
 */

/** Nothing hovered, nothing being drawn: the scene has no tool state here. */
const IDLE_OVERLAY: SceneOverlay = {
  hoverHit: null,
  wireInProgress: null,
  placing: null,
  boxRect: null,
  wireInfo: null,
};

export default function HistoryPreview({
  text,
  themeName,
  gridOn,
  showValues,
  changedIds,
}: {
  /** Canonical `.csx` of the version to draw. */
  text: string;
  themeName: string;
  gridOn: boolean;
  showValues: boolean;
  /**
   * Parts this version adds or changes, outlined so the difference is visible on
   * the canvas itself (§76). Removals cannot be marked — the part is not here.
   */
  changedIds?: readonly string[] | null;
}) {
  const scene = useMemo(() => {
    const built = new DocScene();
    built.sync(CircuitDocument.fromJson(text), 0);
    return built;
  }, [text]);

  // Nothing is selected in a read-only preview; the marks ride the overlay.
  const selection = useMemo(() => new SelectionModel(), []);
  const changed = useMemo(() => new Set(changedIds ?? []), [changedIds]);

  const draw = useCallback<CanvasHostProps["draw"]>(
    (renderer, camera, view, theme) => {
      scene.draw(
        renderer,
        theme,
        camera,
        view,
        selection,
        { ...IDLE_OVERLAY, changedIds: changed },
        undefined,
        gridOn,
        showValues,
      );
    },
    [scene, selection, changed, gridOn, showValues],
  );

  return (
    <CanvasHost
      draw={draw}
      sceneBounds={scene.bounds}
      themeName={themeName}
      animate={false}
      revision={text.length}
    />
  );
}
