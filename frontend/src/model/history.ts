import type { CircuitDocument } from "./document";

/**
 * Undo/redo as a command stack (FRONTEND.md U2). Commands capture
 * before/after state; pointer drags produce many small commands that
 * COALESCE into one undoable gesture via a shared `coalesceKey` (a drag of
 * one component = one undo step, not fifty).
 *
 * The `onEvent` hook is where the post-MVP provenance journal attaches
 * (DESIGN.md §10: coarse edit events doubling as undo-history data) — keep
 * it free of anything finer than command labels.
 */

export interface Command {
  readonly label: string;
  /** Commands with equal keys applied back-to-back merge into one. */
  readonly coalesceKey?: string;
  apply(doc: CircuitDocument): void;
  revert(doc: CircuitDocument): void;
  /** Absorb an already-applied follow-up (its `apply` has run). */
  mergeWith?(next: Command): void;
}

export interface HistoryEvent {
  kind: "execute" | "undo" | "redo";
  label: string;
}

export class UndoHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  onEvent?: (e: HistoryEvent) => void;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  peekUndoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  peekRedoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  execute(doc: CircuitDocument, cmd: Command): void {
    cmd.apply(doc);
    const top = this.undoStack.at(-1);
    if (
      cmd.coalesceKey !== undefined &&
      top?.coalesceKey === cmd.coalesceKey &&
      top.mergeWith !== undefined
    ) {
      top.mergeWith(cmd);
    } else {
      this.undoStack.push(cmd);
    }
    this.redoStack.length = 0;
    this.onEvent?.({ kind: "execute", label: cmd.label });
  }

  undo(doc: CircuitDocument): boolean {
    const cmd = this.undoStack.pop();
    if (cmd === undefined) return false;
    cmd.revert(doc);
    this.redoStack.push(cmd);
    this.onEvent?.({ kind: "undo", label: cmd.label });
    return true;
  }

  redo(doc: CircuitDocument): boolean {
    const cmd = this.redoStack.pop();
    if (cmd === undefined) return false;
    cmd.apply(doc);
    this.undoStack.push(cmd);
    this.onEvent?.({ kind: "redo", label: cmd.label });
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
