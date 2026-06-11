import { describe, expect, it } from "vitest";
import { buildPlan } from "./diff";
import type { CollectedData } from "./export";
import type { ParsedModel } from "./parse";

// Regression: files whose collection names diverge from the real Figma file
// (legacy / pre-Approach-C exports → filename fallback "Color"/"Theme" instead
// of the real "primitives/color"/"semantic"). On a same-file round-trip the
// variables still match by variableId, so their ops must target the REAL
// collection — not spawn duplicate fallback collections and not break the
// figma-write variable lookup (which caused unresolved (?) bindings).

const current: CollectedData = {
  collections: [
    {
      id: "PC", name: "primitives/color", defaultModeId: "p1", modes: [{ modeId: "p1", name: "Mode 1" }],
      variables: [
        { id: "G50", name: "gray/50", resolvedType: "COLOR", valuesByMode: { p1: { r: 0.96, g: 0.96, b: 0.96, a: 1 } }, scopes: [], collectionId: "PC" },
        { id: "G900", name: "gray/900", resolvedType: "COLOR", valuesByMode: { p1: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }, scopes: [], collectionId: "PC" },
      ],
    },
    {
      id: "SEM", name: "semantic", defaultModeId: "light", modes: [{ modeId: "light", name: "light" }, { modeId: "dark", name: "dark" }],
      variables: [
        { id: "BG", name: "input/bg", resolvedType: "COLOR", valuesByMode: { light: { type: "VARIABLE_ALIAS", id: "G50" }, dark: { type: "VARIABLE_ALIAS", id: "G900" } }, scopes: [], collectionId: "SEM" },
      ],
    },
  ],
};

// Legacy parse output: fallback collection names + capitalized fallback modes.
// input/bg's light mode is CHANGED (now points at gray/900) to force an op.
const parsedLegacy: ParsedModel = {
  warnings: [],
  collections: [
    {
      name: "Color", modeNames: ["Mode 1"],
      variables: [
        { variableId: "G50", collectionName: "Color", name: "gray/50", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 0.96, g: 0.96, b: 0.96, a: 1 } } } },
        { variableId: "G900", collectionName: "Color", name: "gray/900", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 0.1, g: 0.1, b: 0.1, a: 1 } } } },
      ],
    },
    {
      name: "Theme", modeNames: ["Light", "Dark"],
      variables: [
        { variableId: "BG", collectionName: "Theme", name: "input/bg", resolvedType: "COLOR", scopes: [], valuesByModeName: { Light: { kind: "alias", targetCollection: "primitives/color", targetName: "gray/900" }, Dark: { kind: "alias", targetCollection: "primitives/color", targetName: "gray/900" } } },
      ],
    },
  ],
};

describe("buildPlan — effective collection resolution (name divergence)", () => {
  it("does not create duplicate collections when variables match existing ones by id", () => {
    const plan = buildPlan(parsedLegacy, current);
    expect(plan.collectionsToCreate).toEqual([]);
    expect(plan.ops.some((o) => o.kind === "createCollection")).toBe(false);
    expect(plan.ops.some((o) => o.kind === "createVariable")).toBe(false);
  });

  it("targets the real collection for the changed alias and resolves the target", () => {
    const plan = buildPlan(parsedLegacy, current);
    const aliases = plan.ops.filter((o) => o.kind === "setAlias");
    // only the Light mode changed (Dark already points at gray/900)
    expect(aliases).toEqual([
      { kind: "setAlias", collection: "semantic", name: "input/bg", mode: "Light", targetCollection: "primitives/color", targetName: "gray/900" },
    ]);
    expect(plan.updates).toEqual([{ collection: "semantic", name: "input/bg", modes: ["Light"] }]);
  });

  it("does not add duplicate modes to the existing collection (case-insensitive)", () => {
    const plan = buildPlan(parsedLegacy, current);
    expect(plan.modesToAdd).toEqual([]);
  });
});
