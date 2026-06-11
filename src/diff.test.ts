import { describe, expect, it } from "vitest";
import { buildPlan } from "./diff";
import type { CollectedData } from "./export";
import type { ParsedModel } from "./parse";

const EMPTY_CURRENT: CollectedData = { collections: [] };

function parsedColor(collection: string, mode: string, name: string, value: ParsedModelLiteral): ParsedModel {
  return {
    warnings: [],
    collections: [
      {
        name: collection,
        modeNames: [mode],
        variables: [
          { variableId: "X1", collectionName: collection, name, resolvedType: "COLOR", scopes: [], valuesByModeName: { [mode]: value } },
        ],
      },
    ],
  };
}
type ParsedModelLiteral = { kind: "literal"; value: { r: number; g: number; b: number; a: number } } | { kind: "alias"; targetCollection: string; targetName: string };

describe("buildPlan — creates", () => {
  it("creates a collection and a variable in a fresh file", () => {
    const parsed = parsedColor("Color", "Mode 1", "color/white", { kind: "literal", value: { r: 1, g: 1, b: 1, a: 1 } });
    const plan = buildPlan(parsed, EMPTY_CURRENT);
    expect(plan.collectionsToCreate).toEqual(["Color"]);
    expect(plan.creates).toEqual([{ collection: "Color", name: "color/white", modes: ["Mode 1"] }]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchangedCount).toBe(0);
    expect(plan.ops.map((o) => o.kind)).toEqual(["createCollection", "createVariable", "setLiteral"]);
  });

  it("orders setLiteral ops before setAlias ops", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [
        {
          name: "primitives/color", modeNames: ["Mode 1"],
          variables: [{ collectionName: "primitives/color", name: "color/white", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 1, g: 1, b: 1, a: 1 } } } }],
        },
        {
          name: "semantic", modeNames: ["light"],
          variables: [{ collectionName: "semantic", name: "color/bg", resolvedType: "COLOR", scopes: [], valuesByModeName: { light: { kind: "alias", targetCollection: "primitives/color", targetName: "color/white" } } }],
        },
      ],
    };
    const plan = buildPlan(parsed, EMPTY_CURRENT);
    const kinds = plan.ops.map((o) => o.kind);
    expect(kinds.indexOf("setLiteral")).toBeLessThan(kinds.indexOf("setAlias"));
    expect(kinds.filter((k) => k === "createCollection").length).toBe(2);
  });
});

describe("buildPlan — updates", () => {
  const current: CollectedData = {
    collections: [
      {
        id: "C1", name: "primitives/color", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Mode 1" }],
        variables: [{ id: "V1", name: "color/white", resolvedType: "COLOR", valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }, scopes: ["ALL_SCOPES"], collectionId: "C1" }],
      },
    ],
  };

  it("marks an unchanged variable as unchanged (no ops)", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [{ name: "primitives/color", modeNames: ["Mode 1"], variables: [{ variableId: "V1", collectionName: "primitives/color", name: "color/white", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 1, g: 1, b: 1, a: 1 } } } }] }],
    };
    const plan = buildPlan(parsed, current);
    expect(plan.unchangedCount).toBe(1);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.ops).toEqual([]);
  });

  it("updates a changed value and matches by id", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [{ name: "primitives/color", modeNames: ["Mode 1"], variables: [{ variableId: "V1", collectionName: "primitives/color", name: "color/white", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 0, g: 0, b: 0, a: 1 } } } }] }],
    };
    const plan = buildPlan(parsed, current);
    expect(plan.updates).toEqual([{ collection: "primitives/color", name: "color/white", modes: ["Mode 1"] }]);
    expect(plan.ops.map((o) => o.kind)).toEqual(["setLiteral"]);
  });

  it("matches by collection+name when the id differs (no duplicate)", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [{ name: "primitives/color", modeNames: ["Mode 1"], variables: [{ variableId: "DIFFERENT", collectionName: "primitives/color", name: "color/white", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 0, g: 0, b: 0, a: 1 } } } }] }],
    };
    const plan = buildPlan(parsed, current);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toHaveLength(1);
  });

  it("warns and skips on a resolved-type mismatch", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [{ name: "primitives/color", modeNames: ["Mode 1"], variables: [{ variableId: "V1", collectionName: "primitives/color", name: "color/white", resolvedType: "FLOAT", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: 5 } } }] }],
    };
    const plan = buildPlan(parsed, current);
    expect(plan.ops).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("type"))).toBe(true);
  });
});
