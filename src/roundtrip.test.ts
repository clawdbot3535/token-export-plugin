import { describe, expect, it, vi, afterEach } from "vitest";
import type { CollectedData } from "./export";
import { buildExport } from "./export";
import { parse } from "./parse";
import { buildPlan } from "./diff";
import { applyPlan } from "./figma-write";
import { collect } from "./collect";
import { createFakeFigma } from "./fake-figma";
import { canonicalize } from "./canonical";

afterEach(() => vi.unstubAllGlobals());

const EMPTY: CollectedData = { collections: [] };

// Exercises the full surface: 2 collections, 2 modes (Light/Dark) on one of
// them, color + number + boolean + string literals, and a cross-collection
// alias (theme/bg/base Light -> primitives/color/blue).
const STATE0: CollectedData = {
  collections: [
    {
      id: "VariableCollectionId:prim",
      name: "primitives",
      defaultModeId: "m:prim",
      modes: [{ modeId: "m:prim", name: "Mode 1" }],
      variables: [
        { id: "VariableID:blue", name: "color/blue", resolvedType: "COLOR",
          valuesByMode: { "m:prim": { r: 0.2, g: 0.4, b: 0.8, a: 1 } }, scopes: ["ALL_SCOPES"], collectionId: "VariableCollectionId:prim" },
        { id: "VariableID:space", name: "space/4", resolvedType: "FLOAT",
          valuesByMode: { "m:prim": 4 }, scopes: ["WIDTH_HEIGHT"], collectionId: "VariableCollectionId:prim" },
      ],
    },
    {
      id: "VariableCollectionId:theme",
      name: "theme",
      defaultModeId: "m:light",
      modes: [{ modeId: "m:light", name: "Light" }, { modeId: "m:dark", name: "Dark" }],
      variables: [
        { id: "VariableID:bg", name: "bg/base", resolvedType: "COLOR",
          valuesByMode: { "m:light": { type: "VARIABLE_ALIAS", id: "VariableID:blue" }, "m:dark": { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
          scopes: ["ALL_SCOPES"], collectionId: "VariableCollectionId:theme" },
        { id: "VariableID:dense", name: "flag/dense", resolvedType: "BOOLEAN",
          valuesByMode: { "m:light": false, "m:dark": true }, scopes: [], collectionId: "VariableCollectionId:theme" },
        { id: "VariableID:font", name: "font/family", resolvedType: "STRING",
          valuesByMode: { "m:light": "Inter", "m:dark": "Inter" }, scopes: [], collectionId: "VariableCollectionId:theme" },
      ],
    },
  ],
};

// NOTE on fidelity scope: canonicalize() strips com.figma.scopes before comparing,
// so this test does NOT verify scope round-tripping — applyPlan never writes scopes,
// so variable scopes are dropped on import (a documented v1 limitation). STATE0
// carries non-empty scopes only to exercise the rest of the pipeline.
describe("import round-trip fidelity", () => {
  it("export -> parse -> buildPlan -> applyPlan -> collect -> export is canonically identical", async () => {
    const files0 = buildExport(STATE0);
    expect(files0.warnings).toEqual([]);

    const fake = createFakeFigma();
    vi.stubGlobal("figma", fake.figma);

    const plan = buildPlan(parse(files0.files), EMPTY);
    const summary = await applyPlan(plan);
    expect(summary.errors).toEqual([]);

    const state1 = await collect();
    const files1 = buildExport(state1);
    expect(files1.warnings).toEqual([]);

    expect(canonicalize(files1.files)).toEqual(canonicalize(files0.files));
  });

  it("round-trips a prefix-collision leaf, restoring the bare Figma name", async () => {
    const COLLISION: CollectedData = {
      collections: [
        {
          id: "VariableCollectionId:prim",
          name: "primitives/color",
          defaultModeId: "m1",
          modes: [{ modeId: "m1", name: "Mode 1" }],
          variables: [
            { id: "VariableID:white", name: "color/white", resolvedType: "COLOR",
              valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }, scopes: [], collectionId: "VariableCollectionId:prim" },
            { id: "VariableID:white-a8", name: "color/white/alpha/500-8", resolvedType: "COLOR",
              valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 0.08 } }, scopes: [], collectionId: "VariableCollectionId:prim" },
            { id: "VariableID:overlay", name: "surface/overlay", resolvedType: "COLOR",
              valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "VariableID:white-a8" } }, scopes: [], collectionId: "VariableCollectionId:prim" },
            { id: "VariableID:base", name: "surface/base", resolvedType: "COLOR",
              valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "VariableID:white" } }, scopes: [], collectionId: "VariableCollectionId:prim" },
          ],
        },
      ],
    };

    const files0 = buildExport(COLLISION);
    const fake = createFakeFigma();
    vi.stubGlobal("figma", fake.figma);
    const summary = await applyPlan(buildPlan(parse(files0.files), EMPTY));
    expect(summary.errors).toEqual([]);

    const state1 = await collect();
    const names = state1.collections.flatMap((c) => c.variables.map((v) => v.name));
    // the collapsed leaf is restored to its bare Figma name (NOT color/white/DEFAULT)…
    expect(names).toContain("color/white");
    expect(names).not.toContain("color/white/DEFAULT");
    // …the deeper group survived the export (it was clobbered before this fix)…
    expect(names).toContain("color/white/alpha/500-8");
    // …and the exported set is canonically identical across the cycle.
    expect(canonicalize(buildExport(state1).files)).toEqual(canonicalize(files0.files));
  });

  it("re-import of the produced files is a no-op (upsert idempotency)", async () => {
    const fake = createFakeFigma();
    vi.stubGlobal("figma", fake.figma);
    await applyPlan(buildPlan(parse(buildExport(STATE0).files), EMPTY));

    const state1 = await collect();
    const files1 = buildExport(state1);
    const replan = buildPlan(parse(files1.files), await collect());

    const totalVars = state1.collections.reduce((n, c) => n + c.variables.length, 0);
    expect(replan.creates).toEqual([]);
    expect(replan.updates).toEqual([]);
    expect(replan.ops).toEqual([]);
    expect(replan.unchangedCount).toBe(totalVars);
  });
});
