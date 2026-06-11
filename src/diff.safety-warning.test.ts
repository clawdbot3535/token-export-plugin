import { describe, expect, it } from "vitest";
import { buildPlan } from "./diff";
import type { CollectedData } from "./export";
import type { ParsedModel } from "./parse";

const nonEmpty: CollectedData = {
  collections: [
    {
      id: "REAL", name: "Real", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Mode 1" }],
      variables: [{ id: "R1", name: "a/b", resolvedType: "COLOR", valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }, scopes: [], collectionId: "REAL" }],
    },
  ],
};

function parsedNew(name = "x/y", collection = "New"): ParsedModel {
  return {
    warnings: [],
    collections: [
      { name: collection, modeNames: ["Mode 1"], variables: [{ collectionName: collection, name, resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 0, g: 0, b: 0, a: 1 } } } }] },
    ],
  };
}

describe("buildPlan — wrong-file safety warning", () => {
  it("warns when creating variables but matching none in a non-empty file", () => {
    const plan = buildPlan(parsedNew(), nonEmpty);
    expect(plan.creates.length).toBeGreaterThan(0);
    expect(plan.updates.length + plan.unchangedCount).toBe(0);
    expect(plan.warnings[0]).toMatch(/none matched/i);
  });

  it("does not warn when importing into an empty file (legitimate new import)", () => {
    const plan = buildPlan(parsedNew(), { collections: [] });
    expect(plan.warnings.some((w) => /none matched/i.test(w))).toBe(false);
  });

  it("does not warn when at least one variable matches (normal update)", () => {
    const parsed: ParsedModel = {
      warnings: [],
      collections: [
        { name: "Real", modeNames: ["Mode 1"], variables: [{ variableId: "R1", collectionName: "Real", name: "a/b", resolvedType: "COLOR", scopes: [], valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 0, g: 0, b: 0, a: 1 } } } }] },
      ],
    };
    const plan = buildPlan(parsed, nonEmpty);
    expect(plan.updates.length).toBe(1);
    expect(plan.warnings.some((w) => /none matched/i.test(w))).toBe(false);
  });
});
