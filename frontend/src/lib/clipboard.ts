/**
 * Clipboard helper (UI_OVERHAUL §76).
 *
 * The async Clipboard API needs a secure context and, in some browsers, a
 * permission the user may refuse; the textarea + `execCommand` path still works
 * where that happens (a dev server on a LAN address, an embedded webview). So:
 * prefer the modern API, fall back to the legacy one, and report whether the text
 * actually made it so the caller can say so.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused or unavailable — try the legacy path rather than losing the copy.
  }
  try {
    if (typeof document === "undefined") return false;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
