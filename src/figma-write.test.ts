import { describe, expect, it, vi, afterEach } from "vitest";
import type { CollectedData } from "./export";
import type { ImportPlan } from "./diff";
import { buildPlan } from "./diff";
import { parse } from "./parse";
import { buildExport } from "./export";
import { applyPlan } from "./figma-write";
import { collect } from "./collect";
import { createFakeFigma } from "./fake-figma";

afterEach(() => vi.unstubAllGlobals());

const EMPTY: CollectedData = { collections: [] };

// A tiny source set: one collection "c" (mode "Mode 1") with two literals and
// one alias (sem -> prim) — enough to exercise create + alias ordering.
const SOURCE: CollectedData = {
  collections: [
    {
      id: "VariableCollectionId:c",
      name: "c",
      defaultModeId: "m1",
      modes: [{ modeId: "m1", name: "Mode 1" }],
      variables: [
        { id: "VariableID:prim", name: "color/prim", resolvedType: "COLOR",
          valuesByMode: { m1: { r: 0.2, g: 0.4, b: 0.8, a: 1 } }, scopes: [], collectionId: "VariableCollectionId:c" },
        { id: "VariableID:sem", name: "color/sem", resolvedType: "COLOR",
          valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "VariableID:prim" } }, scopes: [], collectionId: "VariableCollectionId:c" },
        { id: "VariableID:num", name: "space/4", resolvedType: "FLOAT",
          valuesByMode: { m1: 4 }, scopes: [], collectionId: "VariableCollectionId:c" },
      ],
    },
  ],
};

function planFor(source: CollectedData, current: CollectedData): ImportPlan {
  return buildPlan(parse(buildExport(source).files), current);
}

describe("applyPlan — semantics", () => {
  it("upsert: importing into an empty file creates variables; re-import creates nothing new", async () => {
    const fake = createFakeFigma();
    vi.stubGlobal("figma", fake.figma);

    const first = await applyPlan(planFor(SOURCE, EMPTY));
    expect(first.errors).toEqual([]);
    expect(first.createdVariables).toBe(3);

    // Re-plan against the now-populated state — should be a no-op.
    const replan = planFor(SOURCE, await collect());
    expect(replan.creates).toEqual([]);
    expect(replan.updates).toEqual([]);
    expect(replan.ops).toEqual([]);
    expect(replan.unchangedCount).toBe(3);
  });

  it("alias ordering: the alias binds to its in-plan target with no errors", async () => {
    const fake = createFakeFigma();
    vi.stubGlobal("figma", fake.figma);
    const summary = await applyPlan(planFor(SOURCE, EMPTY));
    expect(summary.errors).toEqual([]);

    const state = await collect();
    const sem = state.collections[0].variables.find((v) => v.name === "color/sem")!;
    const prim = state.collections[0].variables.find((v) => v.name === "color/prim")!;
    // color/sem has a single mode; its only stored value must be an alias to prim.
    const aliasVal = Object.values(sem.valuesByMode)[0];
    expect(aliasVal).toEqual({ type: "VARIABLE_ALIAS", id: prim.id });
  });

  it("no implicit deletion: a variable present only in Figma survives untouched", async () => {
    const extra: CollectedData = {
      collections: [
        {
          id: "VariableCollectionId:c",
          name: "c",
          defaultModeId: "m1",
          modes: [{ modeId: "m1", name: "Mode 1" }],
          variables: [
            { id: "VariableID:keep", name: "legacy/keep", resolvedType: "STRING",
              valuesByMode: { m1: "keepme" }, scopes: [], collectionId: "VariableCollectionId:c" },
          ],
        },
      ],
    };
    const fake = createFakeFigma(extra);
    vi.stubGlobal("figma", fake.figma);

    await applyPlan(planFor(SOURCE, extra));
    const state = await collect();
    const keep = state.collections[0].variables.find((v) => v.name === "legacy/keep");
    expect(keep).toBeDefined();
    expect(keep!.valuesByMode.m1).toBe("keepme");
  });

  it("missing alias target is reported, not thrown, and other ops still apply", async () => {
    // Hand-build a plan whose alias points at a non-existent target.
    const plan: ImportPlan = {
      collectionsToCreate: ["c"],
      modesToAdd: [],
      creates: [{ collection: "c", name: "x", modes: ["Mode 1"] }],
      updates: [],
      unchangedCount: 0,
      warnings: [],
      ops: [
        { kind: "createCollection", name: "c", firstMode: "Mode 1" },
        { kind: "createVariable", collection: "c", name: "x", type: "COLOR" },
        { kind: "setAlias", collection: "c", name: "x", mode: "Mode 1", targetCollection: "c", targetName: "ghost" },
      ],
    };
    const fake = createFakeFigma();
    vi.stubGlobal("figma", fake.figma);
    const summary = await applyPlan(plan);
    expect(summary.createdVariables).toBe(1);
    expect(summary.errors.some((e) => e.includes("ghost"))).toBe(true);
  });
});
