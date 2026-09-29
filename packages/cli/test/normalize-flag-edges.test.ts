import { describe, it, expect } from "vitest";

import { normalizeFlag } from "../src/release-surface/extract-surface.js";

describe("normalizeFlag edge cases", () => {
  it("keeps the last long flag when a flags string names several", () => {
    expect(normalizeFlag("--color, --colour")).toBe("--colour");
  });

  it("falls back to the first short flag when there is no long flag", () => {
    expect(normalizeFlag("-a -b")).toBe("-a");
  });

  it("returns null for an empty or separator-only flags string", () => {
    expect(normalizeFlag("")).toBeNull();
    expect(normalizeFlag("  ,  ")).toBeNull();
  });
});
