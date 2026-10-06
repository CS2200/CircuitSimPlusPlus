import { beforeEach, describe, expect, it } from "vitest";
import { checkForUpdate, dismiss, isDismissed, semverCompare, APP_VERSION } from "./update";

describe("semverCompare", () => {
  it("orders by major/minor/patch, ignoring a leading v", () => {
    expect(semverCompare("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(semverCompare("v1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(semverCompare("0.1.0", "0.1.0")).toBe(0);
    expect(semverCompare("0.1.0", "0.1.1")).toBeLessThan(0);
  });

  it("treats unparseable versions as equal (never nag)", () => {
    expect(semverCompare("dev-build", "0.1.0")).toBe(0);
    expect(semverCompare("0.1.0", "")).toBe(0);
  });
});

function fakeRelease(tag: string | null, ok = true): typeof fetch {
  const response = {
    ok,
    json: () =>
      Promise.resolve(
        tag === null ? {} : { tag_name: tag, html_url: `https://example.test/releases/${tag}` },
      ),
  } as unknown as Response;
  return (() => Promise.resolve(response)) as unknown as typeof fetch;
}

describe("checkForUpdate", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("returns the newer release's info", async () => {
    const info = await checkForUpdate(fakeRelease("v99.0.0"), "o/r");
    expect(info).toEqual({
      latest: "99.0.0",
      url: "https://example.test/releases/v99.0.0",
    });
  });

  it("is silent when current, older, or unparseable", async () => {
    expect(await checkForUpdate(fakeRelease("v0.0.1"), "o/r")).toBeNull();
    expect(await checkForUpdate(fakeRelease(`v${APP_VERSION}`), "o/r")).toBeNull();
    expect(await checkForUpdate(fakeRelease(null), "o/r")).toBeNull();
  });

  it("is silent on HTTP errors and network failure (offline = silent skip)", async () => {
    expect(await checkForUpdate(fakeRelease("v99.0.0", false), "o/r")).toBeNull();
    const offline = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect(await checkForUpdate(offline, "o/r")).toBeNull();
  });

  it("a dismissed version stays hidden; a newer one re-nudges", async () => {
    dismiss("99.0.0");
    expect(isDismissed("99.0.0")).toBe(true);
    expect(await checkForUpdate(fakeRelease("v99.0.0"), "o/r")).toBeNull();
    expect(await checkForUpdate(fakeRelease("v99.0.1"), "o/r")).not.toBeNull();
  });
});
