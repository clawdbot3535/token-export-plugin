import { describe, expect, it } from "vitest";
import { buildPlan } from "./diff";
import type { CollectedData } from "./export";
import type { ParsedModel } from "./parse";

// Regression: legacy token files (no com.figma.collectionName) reconstruct the
// alias TARGET variable under a filename-fallback collection (e.g. "Color"),
// but the alias still names the ORIGINAL collection (from aliasData, e.g.
// "primitives/color"). The setAlias op must resolve the target collection by
// the target variable's name so figma-write can find it.

describe("buildPlan — alias target collection resolution", () => {
  it("rewrites the alias target collection to where the target variable actually lives (legacy fallback)", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [
        {
          name: "Color",
          modeNames: ["Mode 1"],
          variables: [
            { variableId: "W", collectionName: "Color", name: "color/white", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 1, g: 1, b: 1, a: 1 } } } },
          ],
        },
        {
          name: "Theme",
          modeNames: ["Light"],
          variables: [
            { variableId: "BG", collectionName: "Theme", name: "color/bg", resolvedType: "COLOR", scopes: [], valuesByModeName: { Light: { kind: "alias", targetCollection: "primitives/color", targetName: "color/white" } } },
          ],
        },
      ],
    };
    const plan = buildPlan(parsed, { collections: [] });
    const alias = plan.ops.find((o) => o.kind === "setAlias");
    expect(alias).toBeDefined();
    // target collection rewritten from the (absent) "primitives/color" to "Color"
    expect(alias).toMatchObject({ targetCollection: "Color", targetName: "color/white" });
  });

  it("keeps the original target collection when it exists (fresh-export case unchanged)", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [
        {
          name: "primitives/color",
          modeNames: ["Mode 1"],
          variables: [
            { collectionName: "primitives/color", name: "color/white", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 1, g: 1, b: 1, a: 1 } } } },
          ],
        },
        {
          name: "semantic",
          modeNames: ["light"],
          variables: [
            { collectionName: "semantic", name: "color/bg", resolvedType: "COLOR", scopes: [], valuesByModeName: { light: { kind: "alias", targetCollection: "primitives/color", targetName: "color/white" } } },
          ],
        },
      ],
    };
    const plan = buildPlan(parsed, { collections: [] });
    const alias = plan.ops.find((o) => o.kind === "setAlias");
    expect(alias).toMatchObject({ targetCollection: "primitives/color", targetName: "color/white" });
  });

  it("keeps the original target collection when the name is ambiguous across collections", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [
        {
          name: "A", modeNames: ["Mode 1"],
          variables: [{ collectionName: "A", name: "color/white", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 1, g: 1, b: 1, a: 1 } } } }],
        },
        {
          name: "B", modeNames: ["Mode 1"],
          variables: [{ collectionName: "B", name: "color/white", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 0, g: 0, b: 0, a: 1 } } } }],
        },
        {
          name: "Theme", modeNames: ["Light"],
          variables: [{ collectionName: "Theme", name: "color/bg", resolvedType: "COLOR", scopes: [], valuesByModeName: { Light: { kind: "alias", targetCollection: "primitives/color", targetName: "color/white" } } }],
        },
      ],
    };
    const plan = buildPlan(parsed, { collections: [] });
    const alias = plan.ops.find((o) => o.kind === "setAlias");
    // ambiguous (color/white in both A and B, neither named "primitives/color") → keep original
    expect(alias).toMatchObject({ targetCollection: "primitives/color", targetName: "color/white" });
  });

  it("resolves an alias target that already exists in the current Figma file", () => {
    const current: CollectedData = {
      collections: [
        {
          id: "PC", name: "primitives/color", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Mode 1" }],
          variables: [{ id: "W", name: "color/white", resolvedType: "COLOR", valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }, scopes: [], collectionId: "PC" }],
        },
      ],
    };
    const parsed: ParsedModel = {
      warnings: [],
      collections: [
        {
          name: "Theme",
          modeNames: ["Light"],
          variables: [
            { variableId: "BG", collectionName: "Theme", name: "color/bg", resolvedType: "COLOR", scopes: [], valuesByModeName: { Light: { kind: "alias", targetCollection: "wrong/name", targetName: "color/white" } } },
          ],
        },
      ],
    };
    const plan = buildPlan(parsed, current);
    const alias = plan.ops.find((o) => o.kind === "setAlias");
    expect(alias).toMatchObject({ targetCollection: "primitives/color", targetName: "color/white" });
  });
});
