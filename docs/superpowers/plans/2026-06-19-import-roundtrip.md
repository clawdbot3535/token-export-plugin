# Import Round-Trip Fidelity Test + Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Stage 3 of the token-creator project by independently verifying the Figma-import path and adding the round-trip fidelity test (its defining success criterion), using a test-only in-memory Figma fake.

**Architecture:** The import pipeline is already built and split pure-core (`buildExport`, `parse`, `buildPlan`) / impure-edge (`applyPlan` in `figma-write.ts`, plus `collectData` buried in `main.ts`). This plan (1) extracts `collectData` into a testable `src/collect.ts`, (2) builds an in-memory `figma.variables` fake so the impure edges run in vitest, (3) adds a pure `canonicalize` helper, (4) drives the full `buildExport → parse → buildPlan → applyPlan → collect → buildExport` cycle and asserts canonical-DTCG identity, plus targeted `applyPlan` semantic tests, and (5) runs an independent code review.

**Tech Stack:** TypeScript, vitest 2.1, `@figma/plugin-typings` (ambient Figma globals), `build-figma-plugin` (typecheck+bundle). No new dependencies.

---

## File Structure

- **Create `src/fake-figma.ts`** — test-only, in-memory `figma.variables` implementation (stateful). Sole responsibility: be a faithful-enough runtime stand-in for the Figma Variables Plugin API that `applyPlan` (write) and `collect` (read) both exercise. Not imported by `main.ts`, so never bundled.
- **Create `src/collect.ts`** — `export async function collect(): Promise<CollectedData>`, the exact body extracted verbatim from `main.ts`'s private `collectData`. An impure edge (reads `figma.variables.*`), sibling to `figma-write.ts`.
- **Modify `src/main.ts`** — delete the private `collectData` (lines 19-45), import `collect` from `./collect`, replace the 5 `collectData()` call sites with `collect()`, remove now-unused type imports.
- **Create `src/canonical.ts`** — pure `canonicalize(files: ExportFile[])` that strips non-round-tripping fields and sorts keys for a stable deep-equal.
- **Create `src/fake-figma.test.ts`** — proves the fake's own read/write behaviour.
- **Create `src/collect.test.ts`** — proves `collect()` reproduces seeded state through the fake.
- **Create `src/figma-write.test.ts`** — pins `applyPlan` semantics: upsert, alias ordering, no-deletion, missing-target reporting.
- **Create `src/roundtrip.test.ts`** — the Stage 3 criterion: full cycle canonical identity + re-import idempotency.

Existing files referenced (do not change their behaviour): `export.ts` (`buildExport`, `CollectedData`, `CollectedCollection`, `CollectedVariable`, `CollectedValue`, `ExportFile`), `parse.ts` (`parse`, `ImportFile`), `diff.ts` (`buildPlan`, `ImportPlan`), `figma-write.ts` (`applyPlan`), `format.ts` (`FigmaResolvedType`, `RGBA`).

---

### Task 1: In-memory Figma fake

**Files:**
- Create: `src/fake-figma.ts`
- Test: `src/fake-figma.test.ts`

The fake holds mutable collections + variables and serves exactly the `figma.variables.*` surface that `applyPlan` (`figma-write.ts:21,25,43,44,53,60,76,95`) and `collect` (`main.ts:20,25`) call. Local type names are **Fake-prefixed** to avoid shadowing the ambient `Variable`/`VariableCollection` globals from `@figma/plugin-typings`.

- [ ] **Step 1: Write the failing test**

Create `src/fake-figma.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeFigma } from "./fake-figma";

describe("createFakeFigma", () => {
  it("creates a collection with one default mode and renames it", () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("primitives");
    expect(col.modes).toHaveLength(1);
    col.renameMode(col.modes[0].modeId, "Light");
    expect(col.modes[0].name).toBe("Light");
    col.addMode("Dark");
    expect(col.modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
  });

  it("createVariable registers into the collection and the id index immediately", async () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("primitives");
    const v = fake.figma.variables.createVariable("color/blue", col, "COLOR");
    expect(col.variableIds).toContain(v.id);
    const fetched = await fake.figma.variables.getVariableByIdAsync(v.id);
    expect(fetched?.name).toBe("color/blue");
    expect(fetched?.resolvedType).toBe("COLOR");
    expect(fetched?.scopes).toEqual([]);
  });

  it("setValueForMode stores values and getLocalVariableCollectionsAsync reflects them", async () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("c");
    const m = col.modes[0].modeId;
    const v = fake.figma.variables.createVariable("n", col, "FLOAT");
    v.setValueForMode(m, 4);
    const cols = await fake.figma.variables.getLocalVariableCollectionsAsync();
    const got = await fake.figma.variables.getVariableByIdAsync(cols[0].variableIds[0]);
    expect(got?.valuesByMode[m]).toBe(4);
  });

  it("createVariableAlias returns a VARIABLE_ALIAS pointing at the target id", () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("c");
    const target = fake.figma.variables.createVariable("t", col, "COLOR");
    const alias = fake.figma.variables.createVariableAlias(target);
    expect(alias).toEqual({ type: "VARIABLE_ALIAS", id: target.id });
  });

  it("mints a fresh id per created variable", () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("c");
    const a = fake.figma.variables.createVariable("a", col, "STRING");
    const b = fake.figma.variables.createVariable("b", col, "STRING");
    expect(a.id).not.toBe(b.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/fake-figma.test.ts`
Expected: FAIL — `Cannot find module './fake-figma'`.

- [ ] **Step 3: Write the implementation**

Create `src/fake-figma.ts`:

```ts
// Test-only in-memory model of the Figma Variables Plugin API. Implements
// exactly the figma.variables.* surface that applyPlan (write) and collect
// (read) touch — nothing more. Local types are Fake-prefixed so they do not
// shadow the ambient Variable/VariableCollection globals. NOT imported by
// main.ts, so build-figma-plugin never bundles it.
//
// Deliberate simplifications (documented so drift from real Figma is visible):
// - a new collection starts with one mode named "Mode 1";
// - createVariable defaults scopes to [] (applyPlan never sets scopes);
// - no value/type validation beyond what applyPlan itself performs.

import type { CollectedData, CollectedValue } from "./export";
import type { FigmaResolvedType } from "./format";

interface FakeMode {
  modeId: string;
  name: string;
}

interface FakeVariable {
  id: string;
  name: string;
  resolvedType: FigmaResolvedType;
  valuesByMode: Record<string, CollectedValue>;
  scopes: string[];
  variableCollectionId: string;
  setValueForMode(modeId: string, value: CollectedValue): void;
}

interface FakeCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: FakeMode[];
  variableIds: string[];
  renameMode(modeId: string, name: string): void;
  addMode(name: string): string;
}

export interface FakeFigma {
  variables: {
    getLocalVariableCollectionsAsync(): Promise<FakeCollection[]>;
    getVariableByIdAsync(id: string): Promise<FakeVariable | null>;
    createVariableCollection(name: string): FakeCollection;
    createVariable(name: string, collection: FakeCollection, type: FigmaResolvedType): FakeVariable;
    createVariableAlias(target: FakeVariable): { type: "VARIABLE_ALIAS"; id: string };
  };
}

export interface FakeFigmaHandle {
  figma: FakeFigma;
}

export function createFakeFigma(initial: CollectedData = { collections: [] }): FakeFigmaHandle {
  let seq = 0;
  const nextId = (prefix: string): string => {
    seq += 1;
    return `${prefix}:${seq}`;
  };

  const collections: FakeCollection[] = [];
  const varById = new Map<string, FakeVariable>();

  function makeVariable(
    id: string,
    name: string,
    resolvedType: FigmaResolvedType,
    variableCollectionId: string,
    scopes: string[],
    valuesByMode: Record<string, CollectedValue>,
  ): FakeVariable {
    const v: FakeVariable = {
      id,
      name,
      resolvedType,
      valuesByMode: { ...valuesByMode },
      scopes: [...scopes],
      variableCollectionId,
      setValueForMode(modeId, value) {
        this.valuesByMode[modeId] = value;
      },
    };
    return v;
  }

  function makeCollection(id: string, name: string, modes: FakeMode[], defaultModeId: string): FakeCollection {
    const col: FakeCollection = {
      id,
      name,
      defaultModeId,
      modes: modes.map((m) => ({ ...m })),
      variableIds: [],
      renameMode(modeId, newName) {
        const mode = this.modes.find((m) => m.modeId === modeId);
        if (mode) mode.name = newName;
      },
      addMode(modeName) {
        const modeId = nextId("m");
        this.modes.push({ modeId, name: modeName });
        return modeId;
      },
    };
    return col;
  }

  // Seed from the initial CollectedData (preserving its ids), if any.
  for (const c of initial.collections) {
    const col = makeCollection(c.id, c.name, c.modes, c.defaultModeId);
    collections.push(col);
    for (const v of c.variables) {
      const fv = makeVariable(v.id, v.name, v.resolvedType, c.id, v.scopes, v.valuesByMode);
      varById.set(fv.id, fv);
      col.variableIds.push(fv.id);
    }
  }

  const figma: FakeFigma = {
    variables: {
      getLocalVariableCollectionsAsync: () => Promise.resolve([...collections]),
      getVariableByIdAsync: (id) => Promise.resolve(varById.get(id) ?? null),
      createVariableCollection(name) {
        const modeId = nextId("m");
        const col = makeCollection(nextId("VariableCollectionId"), name, [{ modeId, name: "Mode 1" }], modeId);
        collections.push(col);
        return col;
      },
      createVariable(name, collection, type) {
        const v = makeVariable(nextId("VariableID"), name, type, collection.id, [], {});
        varById.set(v.id, v);
        collection.variableIds.push(v.id);
        return v;
      },
      createVariableAlias(target) {
        return { type: "VARIABLE_ALIAS", id: target.id };
      },
    },
  };

  return { figma };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/fake-figma.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/christian/Dev/figma-token-export
git add src/fake-figma.ts src/fake-figma.test.ts
git commit -m "test: in-memory figma.variables fake for import-side tests"
```

---

### Task 2: Extract `collect()` into `src/collect.ts`

**Files:**
- Create: `src/collect.ts`
- Modify: `src/main.ts` (delete `collectData` at lines 19-45; import + use `collect`; drop unused type imports)
- Test: `src/collect.test.ts`

This is a behaviour-preserving extraction: `collect()` is `collectData`'s body verbatim. The test drives it through the Task-1 fake.

- [ ] **Step 1: Write the failing test**

Create `src/collect.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/collect.test.ts`
Expected: FAIL — `Cannot find module './collect'`.

- [ ] **Step 3: Create `src/collect.ts`**

Copy the exact body from `main.ts:19-45` into a new exported function:

```ts
// Impure edge: reads the live figma.variables.* into the pure CollectedData
// shape consumed by buildExport/buildPlan. Extracted from main.ts so it can be
// unit-/round-trip-tested against an in-memory figma fake. No decision logic.

import type { CollectedCollection, CollectedData, CollectedValue, CollectedVariable } from "./export";

export async function collect(): Promise<CollectedData> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const out: CollectedCollection[] = [];
  for (const col of collections) {
    const variables: CollectedVariable[] = [];
    for (const id of col.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v) continue;
      variables.push({
        id: v.id,
        name: v.name,
        resolvedType: v.resolvedType,
        valuesByMode: v.valuesByMode as Record<string, CollectedValue>,
        scopes: v.scopes as unknown as string[],
        collectionId: v.variableCollectionId,
      });
    }
    out.push({
      id: col.id,
      name: col.name,
      defaultModeId: col.defaultModeId,
      modes: col.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      variables,
    });
  }
  return { collections: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/collect.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Update `main.ts` to use the extracted function**

In `src/main.ts`:
1. Delete the private `async function collectData(): Promise<CollectedData> { … }` block (currently lines 19-45).
2. Add to the import block: `import { collect } from "./collect";`
3. Replace every occurrence of `collectData()` with `collect()` (5 call sites: the `buildExport(await collectData())` and `buildPlan(parse(...), await collectData())` lines).
4. Remove any import names in `main.ts` that are now unused after deleting `collectData` (candidates: `CollectedCollection`, `CollectedValue`, `CollectedVariable`, and possibly `CollectedData` — keep only those still referenced by remaining code).

- [ ] **Step 6: Verify the plugin still typechecks and builds**

Run: `cd /Users/christian/Dev/figma-token-export && npm run typecheck`
Expected: PASS, no errors. If it reports an unused import in `main.ts`, remove that name and re-run.

Run: `cd /Users/christian/Dev/figma-token-export && npm run build`
Expected: build succeeds (the plugin entry compiles; the fake is not bundled).

- [ ] **Step 7: Run the full suite (no regressions)**

Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/christian/Dev/figma-token-export
git add src/collect.ts src/collect.test.ts src/main.ts
git commit -m "refactor: extract collectData into testable src/collect.ts"
```

---

### Task 3: Pin `applyPlan` semantics

**Files:**
- Create: `src/figma-write.test.ts`

These are **characterization tests**: they assert `applyPlan`'s CURRENT behaviour against the fake — no source change is expected. They should pass on first run. If any fails, you have found a real import bug — STOP and report it rather than editing the test to match.

- [ ] **Step 1: Write the tests**

Create `src/figma-write.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests**

Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/figma-write.test.ts`
Expected: PASS (4 tests). If a test fails, do NOT edit it to pass — investigate whether `applyPlan`/`diff` has a real bug and report.

- [ ] **Step 3: Commit**

```bash
cd /Users/christian/Dev/figma-token-export
git add src/figma-write.test.ts
git commit -m "test: pin applyPlan upsert/alias-order/no-deletion semantics"
```

---

### Task 4: Canonicalizer + round-trip fidelity test

**Files:**
- Create: `src/canonical.ts`
- Test: `src/roundtrip.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/roundtrip.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/roundtrip.test.ts`
Expected: FAIL — `Cannot find module './canonical'`.

- [ ] **Step 3: Implement `src/canonical.ts`**

```ts
// Pure: reduce exported token files to a canonical form for fidelity comparison.
// Strips the two extension fields that are Figma-assigned and legitimately do
// NOT survive a round-trip (the importer mints new variable ids; applyPlan does
// not set scopes), ignores $description, and sorts all keys so a deep-equal is
// order-insensitive. Everything the token contract guarantees — token path,
// $type, $value, mode/collection names, and com.figma.aliasData (so aliases are
// compared by target, "preserved unresolved") — is kept.

import type { ExportFile } from "./export";

const STRIP_EXTENSION_KEYS = new Set(["com.figma.variableId", "com.figma.scopes"]);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (key === "$description") continue;
      if (key === "$extensions") {
        const ext = obj[key] as Record<string, unknown>;
        const cleanedExt: Record<string, unknown> = {};
        for (const ek of Object.keys(ext).sort()) {
          if (STRIP_EXTENSION_KEYS.has(ek)) continue;
          cleanedExt[ek] = clean(ext[ek]);
        }
        out[key] = cleanedExt;
        continue;
      }
      out[key] = clean(obj[key]);
    }
    return out;
  }
  return node;
}

export function canonicalize(files: ExportFile[]): Array<{ filename: string; tree: unknown }> {
  return [...files]
    .map((f) => ({ filename: f.filename, tree: clean(JSON.parse(f.json)) }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/roundtrip.test.ts`
Expected: PASS (2 tests). If the fidelity assertion fails, print both canonical forms (`console.log(JSON.stringify(canonicalize(files0.files), null, 2))`) and diff them — a mismatch in a kept field is a real import bug; a mismatch in a Figma-assigned field means it needs adding to `STRIP_EXTENSION_KEYS` (justify in the comment).

- [ ] **Step 5: Commit**

```bash
cd /Users/christian/Dev/figma-token-export
git add src/canonical.ts src/roundtrip.test.ts
git commit -m "test: round-trip fidelity + re-import idempotency (Stage 3 criterion)"
```

---

### Task 5: Independent verification + final review

**Files:** none (review + verification only)

- [ ] **Step 1: Full green gate**

Run: `cd /Users/christian/Dev/figma-token-export && npm run typecheck && npx vitest run && npm run build`
Expected: typecheck clean, all tests pass, build emits the plugin. Record the test count.

- [ ] **Step 2: Independent code review of the import path**

Dispatch a code review (code-reviewer subagent) over `src/parse.ts`, `src/diff.ts`, `src/figma-write.ts`, `src/collect.ts`, judged against the 5 import semantics (upsert / modes-by-name / alias topological order / no implicit deletion / round-trip fidelity). Provide the reviewer the parent design's Stage-3 semantics (from this plan's spec) as the rubric.

- [ ] **Step 3: Triage findings**

Fix CRITICAL and HIGH findings (with a test if behaviour changes). Record MEDIUM/LOW findings in the PR/summary without necessarily fixing. If a fix changes behaviour, add or update a test in `figma-write.test.ts` / `roundtrip.test.ts` to cover it, and re-run Step 1.

- [ ] **Step 4: Final commit (only if Step 3 changed code)**

```bash
cd /Users/christian/Dev/figma-token-export
git add -A
git commit -m "fix: address import-path review findings"
```

---

## Notes for the implementer

- **Working directory:** all commands run in `/Users/christian/Dev/figma-token-export` (a DIFFERENT repo from `token-inspector`). The branch `feat/import-roundtrip` already exists and holds the spec commit.
- **`figma` global:** ambient (from `@figma/plugin-typings`). Tests install the fake with `vi.stubGlobal("figma", fake.figma)` and clean up with `vi.unstubAllGlobals()` in `afterEach`. Never reference the fake where the ambient `Variable`/`VariableCollection` type is expected — `stubGlobal` is untyped, so there is no friction.
- **Do not modify** `export.ts`, `parse.ts`, `diff.ts`, `figma-write.ts`, `format.ts`, `mapping.ts` behaviour. The only production change is the `collectData → collect` extraction (Task 2). Everything else is additive (new files + new tests).
```
