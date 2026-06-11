import { describe, expect, it } from "vitest";
import { collectionModeForFile } from "./import-mapping";

describe("collectionModeForFile", () => {
  it("maps theme files to a shared collection with a mode", () => {
    expect(collectionModeForFile("light.tokens.json")).toEqual({ collection: "Theme", mode: "Light" });
    expect(collectionModeForFile("dark.tokens.json")).toEqual({ collection: "Theme", mode: "Dark" });
  });
  it("maps known single-mode buckets with a null mode", () => {
    expect(collectionModeForFile("color.tokens.json")).toEqual({ collection: "Color", mode: null });
    expect(collectionModeForFile("typography.tokens.json")).toEqual({ collection: "Typography", mode: null });
    expect(collectionModeForFile("dimension.tokens.json")).toEqual({ collection: "Dimension", mode: null });
    expect(collectionModeForFile("global.tokens.json")).toEqual({ collection: "Global", mode: null });
  });
  it("falls back to the base filename for unknown files", () => {
    expect(collectionModeForFile("my-brand-set.tokens.json")).toEqual({ collection: "my-brand-set", mode: null });
  });
});
