// src/settings.test.ts
import { describe, expect, it } from "vitest";
import { normalizeHost, normalizePath, validateSettings, withDefaults, type Settings } from "./settings";

const gh: Settings = { provider: "github", owner: "me", repo: "tokens", branch: "main", path: "tokens", host: "" };
const gl: Settings = { provider: "gitlab", owner: "group/sub", repo: "tokens", branch: "main", path: "tokens", host: "https://gitlab.example.com" };

describe("validateSettings", () => {
  it("accepts valid github settings", () => {
    expect(validateSettings(gh)).toEqual([]);
  });
  it("accepts valid gitlab settings (with host)", () => {
    expect(validateSettings(gl)).toEqual([]);
  });
  it("accepts gitlab settings with an empty host (defaults to gitlab.com)", () => {
    expect(validateSettings({ ...gl, host: "" })).toEqual([]);
  });
  it("rejects empty owner/repo/branch with field-named errors", () => {
    const errs = validateSettings({ ...gh, owner: " ", repo: "", branch: "" });
    expect(errs.some((e) => /owner/i.test(e))).toBe(true);
    expect(errs.some((e) => /repo/i.test(e))).toBe(true);
    expect(errs.some((e) => /branch/i.test(e))).toBe(true);
  });
  it("rejects a gitlab host without an http(s) scheme", () => {
    const errs = validateSettings({ ...gl, host: "gitlab.example.com" });
    expect(errs.some((e) => /host/i.test(e))).toBe(true);
  });
  it("allows an empty path (repo root)", () => {
    expect(validateSettings({ ...gh, path: "" })).toEqual([]);
  });
});

describe("normalizePath", () => {
  it("strips leading and trailing slashes", () => {
    expect(normalizePath("/tokens/")).toBe("tokens");
    expect(normalizePath("a/b/")).toBe("a/b");
  });
  it("returns empty string unchanged", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath("   ")).toBe("");
  });
});

describe("normalizeHost", () => {
  it("trims and strips trailing slashes", () => {
    expect(normalizeHost(" https://gitlab.com/ ")).toBe("https://gitlab.com");
    expect(normalizeHost("https://gl.example.com//")).toBe("https://gl.example.com");
    expect(normalizeHost("")).toBe("");
  });
});

describe("withDefaults", () => {
  it("fills missing provider and host on legacy stored settings", () => {
    expect(withDefaults({ owner: "me", repo: "tokens", branch: "main", path: "tokens" })).toEqual({
      provider: "github", owner: "me", repo: "tokens", branch: "main", path: "tokens", host: "",
    });
  });
  it("preserves gitlab provider and host", () => {
    expect(withDefaults(gl)).toEqual(gl);
  });
  it("defaults branch to main and path/host to empty when absent", () => {
    expect(withDefaults({})).toEqual({ provider: "github", owner: "", repo: "", branch: "main", path: "", host: "" });
  });
});
