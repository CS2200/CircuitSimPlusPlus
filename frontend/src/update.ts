/**
 * Update nudge (DESIGN.md §9): on startup, fetch the latest release tag
 * from our GitHub repo, semver-compare with the running version, and (if
 * behind) show a friendly "please upgrade" dialog with a download link.
 * Never forced, never auto-installs. Offline / any error = silent skip.
 */

import pkg from "../package.json" with { type: "json" };

/**
 * The public github.com mirror to poll, "owner/name". Releases live there and
 * are read with no auth — GT's GHES cannot serve them (it forbids public repos,
 * so an anonymous read gets a 404). See docs/distribution.md.
 *
 * TODO(setup): replace OWNER with the github.com account/org once the mirror
 * repo exists. Until then the check 404s and silently skips.
 */
export const GITHUB_REPO = "OWNER/CircuitSimPlusPlus";

/** Where releases are served: the public github.com mirror, not GT's GHES. */
export const RELEASES_HOST = "github.com";

/** Release API base (github.com; on GHES this was `<host>/api/v3`). */
export const RELEASES_API = "https://api.github.com";

export const APP_VERSION: string = pkg.version;

/** The repo to poll; `?updateRepo=owner/name` overrides (dev/e2e hook). */
function repo(): string {
  if (typeof window !== "undefined") {
    const override = new URLSearchParams(window.location.search).get("updateRepo");
    if (override) return override;
  }
  return GITHUB_REPO;
}

export interface UpdateInfo {
  latest: string;
  url: string;
}

/** Semver compare: positive when a > b, negative when a < b, 0 when equal. */
export function semverCompare(a: string, b: string): number {
  const num = (s: string | undefined): number => (s === undefined || s === "" ? NaN : Number(s));
  const pa = a.replace(/^v/, "").split(".").map(num);
  const pb = b.replace(/^v/, "").split(".").map(num);
  for (let i = 0; i < 3; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) {
      // Missing components of a SHORTER version are 0 (1.0 == 1.0.0), but a
      // version with no numeric head at all is unparseable → equal (never nag).
      if (i === 0 || Number.isNaN(x) || Number.isNaN(y)) return 0;
      return (x ?? 0) - (y ?? 0);
    }
    if (x !== y) return x - y;
  }
  return 0;
}

const DISMISS_KEY = "circuitsimpp.update.dismissed";

/** localStorage when available, else per-process memory (private mode, tests). */
const memoryStore = new Map<string, string>();

function storage(): Pick<Storage, "getItem" | "setItem"> {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // restricted context — fall through to memory
  }
  return {
    getItem: (k) => memoryStore.get(k) ?? null,
    setItem: (k, v) => void memoryStore.set(k, v),
  };
}

/** A dismissal applies to one specific version (a newer one re-nudges). */
export function isDismissed(latest: string): boolean {
  return storage().getItem(DISMISS_KEY) === latest;
}

export function dismiss(latest: string): void {
  storage().setItem(DISMISS_KEY, latest);
}

/**
 * Check GitHub for a newer release. Returns null when: no repo configured,
 * offline, the API errors, or the running version is current.
 */
export async function checkForUpdate(
  fetchFn: typeof fetch = fetch,
  repoName: string = repo(),
): Promise<UpdateInfo | null> {
  if (repoName === "") return null;
  try {
    const res = await fetchFn(`${RELEASES_API}/repos/${repoName}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const tag = data.tag_name;
    const url = data.html_url;
    if (typeof tag !== "string" || typeof url !== "string") return null;
    const latest = tag.replace(/^v/, "");
    if (semverCompare(latest, APP_VERSION) <= 0) return null;
    if (isDismissed(latest)) return null;
    return { latest, url };
  } catch {
    return null; // offline / DNS / JSON — silent skip, per §9
  }
}
