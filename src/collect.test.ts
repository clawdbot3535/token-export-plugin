import { describe, expect, it, vi, afterEach } from "vitest";
import type { CollectedData } from "./export";
import { createFakeFigma } from "./fake-figma";
import { collect } from "./collect";

afterEach(() => vi.unstubAllGlobals());

const SEED: CollectedData = {
  collections: [
    {
      id: "VariableCollectionId:theme",
      name: "theme",
      defaultModeId: "m:light",
      modes: [
        { modeId: "m:light", name: "Light" },
        { modeId: "m:dark", name: "Dark" },
      ],
      variables: [
        {
          id: "VariableID:bg",
          name: "bg/base",
          resolvedType: "COLOR",
          valuesByMode: { "m:light": { r: 0.2, g: 0.4, b: 0.8, a: 1 }, "m:dark": { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
          scopes: ["ALL_SCOPES"],
          collectionId: "VariableCollectionId:theme",
        },
      ],
    },
  ],
};

describe("collect", () => {
  it("reproduces the seeded Figma state as CollectedData", async () => {
    vi.stubGlobal("figma", createFakeFigma(SEED).figma);
    const out = await collect();
    expect(out).toEqual(SEED);
  });
});
