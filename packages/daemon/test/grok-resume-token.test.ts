import { describe, expect, it } from "vitest";
import { validateResumeToken } from "../src/domain/resume-token-validation.js";

describe("grok resume-token validation", () => {
  it("requires a UUID without exposing the rejected token", () => {
    const result = validateResumeToken("grok", "abc-def");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/UUID/i);
      expect(result.error).not.toContain("abc-def");
    }
  });

  it("trims a valid grok UUID", () => {
    expect(validateResumeToken("grok", "  5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a  ")).toEqual({
      ok: true,
      token: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      resumeType: "grok_id",
    });
  });

  it("does not impose grok UUID rules on Claude", () => {
    expect(validateResumeToken("claude-code", "abc-def")).toMatchObject({ ok: true, token: "abc-def" });
  });
});
