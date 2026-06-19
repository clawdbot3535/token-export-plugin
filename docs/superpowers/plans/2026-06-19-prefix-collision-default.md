# Leaf-vs-Group Prefix-Collision Fix (reserved DEFAULT key) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the exporter from dropping variables whose name is a path-prefix of other variables (`color/white` vs `color/white/alpha/*`) by emitting the colliding leaf under a reserved `DEFAULT` child key, with a marker that import reverses — so both survive, the export is valid DTCG, and the round-trip restores the exact Figma names.

**Architecture:** All in `figma-token-export`. Export (`export.ts`) detects prefix-collision leaves and nests them at `<name>/DEFAULT` (+ a `com.figma.collapsedDefault` marker) instead of clobbering the deeper group; alias targets to a collapsed leaf are rewritten to `…/DEFAULT`. Import (`parse.ts`) reverses it via the marker. Inspector repo unchanged.

**Tech Stack:** TypeScript, vitest 2.1. Pure functions (`buildExport`, `parse`) + the in-memory figma fake (`fake-figma.ts`) for the round-trip.

---

## File Structure
- **Modify `src/export.ts`** — add exported `findCollapsedLeaves(data)`; in `buildExport` use it to (a) nest a colliding leaf at `<name>/DEFAULT` + marker, (b) rewrite alias targets to collapsed leaves.
- **Modify `src/parse.ts`** — add a collapsed-names pre-pass; in the main walk, un-rename marked `<name>/DEFAULT` leaves to `<name>` and un-rewrite alias targets.
- **Modify tests:** `src/export.test.ts` (collapse + marker + alias rewrite + non-colliding untouched), `src/parse.test.ts` (un-rename), `src/roundtrip.test.ts` (collision fixture → bare Figma name restored).

---

### Task 1: Export side — collapse colliding leaves under `DEFAULT`

**Files:**
- Modify: `src/export.ts`
- Test: `src/export.test.ts`

- [ ] **Step 1: Write the failing tests.** Add to `src/export.test.ts` a new describe block (it already imports `{ buildExport, type CollectedData }` from `./export`; add `findCollapsedLeaves` to that import):

```ts
describe("buildExport — prefix-collision collapse", () => {
  const data: CollectedData = {
    collections: [
      {
        id: "VariableCollectionId:c",
        name: "color",
        defaultModeId: "m1",
        modes: [{ modeId: "m1", name: "Mode 1" }],
        variables: [
          { id: "VariableID:white", name: "color/white", resolvedType: "COLOR",
            valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }, scopes: [], collectionId: "VariableCollectionId:c" },
          { id: "VariableID:white-a8", name: "color/white/alpha/500-8", resolvedType: "COLOR",
            valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 0.08 } }, scopes: [], collectionId: "VariableCollectionId:c" },
          { id: "VariableID:red500", name: "color/red/500", resolvedType: "COLOR",
            valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } }, scopes: [], collectionId: "VariableCollectionId:c" },
          { id: "VariableID:surface", name: "surface/base", resolvedType: "COLOR",
            valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "VariableID:white" } }, scopes: [], collectionId: "VariableCollectionId:c" },
        ],
      },
    ],
  };

  it("findCollapsedLeaves flags only names that prefix another variable", () => {
    expect(findCollapsedLeaves(data)).toEqual(new Set(["color/white"]));
  });

  it("emits a colliding leaf under DEFAULT with a marker, keeping the deeper group", () => {
    const tree = JSON.parse(buildExport(data).files[0].json);
    // color/white is now a group: DEFAULT (the colour) + alpha (the group survives)
    expect(tree.color.white.$value).toBeUndefined(); // no longer a token node
    expect(tree.color.white.DEFAULT.$value).toBeDefined();
    expect(tree.color.white.DEFAULT.$extensions["com.figma.collapsedDefault"]).toBe(true);
    expect(tree.color.white.alpha["500-8"].$value).toBeDefined();
    // a non-colliding leaf is untouched
    expect(tree.color.red["500"].$value).toBeDefined();
    expect(tree.color.red["500"].DEFAULT).toBeUndefined();
  });

  it("rewrites alias targets that point at a collapsed leaf", () => {
    const tree = JSON.parse(buildExport(data).files[0].json);
    expect(tree.surface.base.$extensions["com.figma.aliasData"].targetVariableName).toBe("color/white/DEFAULT");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/export.test.ts -t "prefix-collision collapse"`
Expected: FAIL — `findCollapsedLeaves` is not exported; `tree.color.white.$value` is defined (clobbered today) / no DEFAULT.

- [ ] **Step 3: Add `findCollapsedLeaves`** to `src/export.ts` (near the top, after the type declarations, before `buildExport`):

```ts
/** Variable names that are a strict path-prefix of another variable's name.
 *  These cannot coexist with the deeper group at the same DTCG path, so the
 *  exporter emits them under a reserved DEFAULT child key instead of clobbering
 *  (or being clobbered by) the group. */
export function findCollapsedLeaves(data: CollectedData): Set<string> {
  const names: string[] = [];
  for (const col of data.collections) for (const v of col.variables) names.push(v.name);
  const collapsed = new Set<string>();
  for (const a of names) {
    if (names.some((b) => b.startsWith(`${a}/`))) collapsed.add(a);
  }
  return collapsed;
}
```

- [ ] **Step 4: Use it in `buildExport`.** Make three edits inside `buildExport`:

(a) After `const ctx: ResolveCtx = { idToVar, idToCol };` add:
```ts
  const collapsed = findCollapsedLeaves(data);
```

(b) In the alias block, change the `targetVariableName` line. Replace:
```ts
          const target = ctx.idToVar.get(raw.id);
          if (target) {
            extensions["com.figma.aliasData"] = {
              targetVariableName: target.name,
              targetVariableSetName: ctx.idToCol.get(target.collectionId)?.name ?? "",
            };
          }
```
with:
```ts
          const target = ctx.idToVar.get(raw.id);
          if (target) {
            extensions["com.figma.aliasData"] = {
              targetVariableName: collapsed.has(target.name) ? `${target.name}/DEFAULT` : target.name,
              targetVariableSetName: ctx.idToCol.get(target.collectionId)?.name ?? "",
            };
          }
```

(c) Replace the leaf-build + `setNested` tail:
```ts
        const leaf: TokenLeaf = {
          $type: tokenTypeFor(v.resolvedType),
          $value: value,
          $extensions: extensions,
        };
        setNested(tree, v.name.split("/"), leaf);
```
with:
```ts
        if (collapsed.has(v.name)) extensions["com.figma.collapsedDefault"] = true;
        const leaf: TokenLeaf = {
          $type: tokenTypeFor(v.resolvedType),
          $value: value,
          $extensions: extensions,
        };
        const path = collapsed.has(v.name) ? [...v.name.split("/"), "DEFAULT"] : v.name.split("/");
        setNested(tree, path, leaf);
```

- [ ] **Step 5: Run to verify it passes.**
Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/export.test.ts`
Expected: PASS (the 3 new tests + all existing export tests — non-colliding fixtures are unaffected since `findCollapsedLeaves` returns empty for them).

- [ ] **Step 6: Typecheck + commit.**
Run: `cd /Users/christian/Dev/figma-token-export && npm run typecheck` (expect clean).
```bash
git add src/export.ts src/export.test.ts
git commit -m "feat(export): collapse prefix-collision leaves under a DEFAULT key + rewrite alias targets"
```

---

### Task 2: Import side — reverse the collapse via the marker

**Files:**
- Modify: `src/parse.ts`
- Test: `src/parse.test.ts`

- [ ] **Step 1: Write the failing tests.** Add to `src/parse.test.ts` (it already imports `{ parse }` and uses `ImportFile`-shaped `{ filename, json }` objects):

```ts
describe("parse — collapsed DEFAULT round-trip", () => {
  it("restores the bare variable name from a com.figma.collapsedDefault leaf", () => {
    const file = {
      filename: "color.tokens.json",
      json: JSON.stringify({
        color: {
          white: {
            DEFAULT: {
              $type: "color",
              $value: { colorSpace: "srgb", components: [1, 1, 1], alpha: 1, hex: "#FFFFFF" },
              $extensions: { "com.figma.collectionName": "color", "com.figma.modeName": "Mode 1", "com.figma.resolvedType": "COLOR", "com.figma.collapsedDefault": true },
            },
          },
        },
      }),
    };
    const model = parse([file]);
    const names = model.collections.flatMap((c) => c.variables.map((v) => v.name));
    expect(names).toContain("color/white");
    expect(names).not.toContain("color/white/DEFAULT");
  });

  it("un-rewrites an alias target that points at a collapsed leaf", () => {
    const file = {
      filename: "color.tokens.json",
      json: JSON.stringify({
        color: {
          white: {
            DEFAULT: {
              $type: "color",
              $value: { colorSpace: "srgb", components: [1, 1, 1], alpha: 1, hex: "#FFFFFF" },
              $extensions: { "com.figma.collectionName": "color", "com.figma.modeName": "Mode 1", "com.figma.resolvedType": "COLOR", "com.figma.collapsedDefault": true },
            },
          },
        },
        surface: {
          base: {
            $type: "color",
            $value: { colorSpace: "srgb", components: [1, 1, 1], alpha: 1, hex: "#FFFFFF" },
            $extensions: {
              "com.figma.collectionName": "color", "com.figma.modeName": "Mode 1", "com.figma.resolvedType": "COLOR",
              "com.figma.aliasData": { targetVariableName: "color/white/DEFAULT", targetVariableSetName: "color" },
            },
          },
        },
      }),
    };
    const model = parse([file]);
    const surface = model.collections.flatMap((c) => c.variables).find((v) => v.name === "surface/base")!;
    const val = Object.values(surface.valuesByModeName)[0];
    expect(val).toEqual({ kind: "alias", targetCollection: "color", targetName: "color/white" });
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/parse.test.ts -t "collapsed DEFAULT round-trip"`
Expected: FAIL — names contains `color/white/DEFAULT` (not un-renamed); alias targetName is `color/white/DEFAULT`.

- [ ] **Step 3: Add the collapsed-names pre-pass** to `src/parse.ts`. Add this helper above `export function parse` (it reuses the module-internal `walk`):

```ts
/** Names (bare, minus the trailing DEFAULT segment) of leaves marked
 *  com.figma.collapsedDefault — collected up front so alias/leaf ordering across
 *  files doesn't matter when un-rewriting alias targets. */
function collectCollapsedNames(files: ImportFile[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    let tree: Record<string, unknown>;
    try {
      tree = JSON.parse(file.json) as Record<string, unknown>;
    } catch {
      continue;
    }
    walk(tree, [], (path, leaf) => {
      const ext = (leaf.$extensions ?? {}) as Record<string, unknown>;
      if (ext["com.figma.collapsedDefault"] === true && path[path.length - 1] === "DEFAULT") {
        names.add(path.slice(0, -1).join("/"));
      }
    });
  }
  return names;
}
```

- [ ] **Step 4: Use it in `parse`.** Two edits inside `export function parse`:

(a) At the top of `parse`, after `const collectionModes = new Map<string, Set<string>>();`, add:
```ts
  const collapsedNames = collectCollapsedNames(files);
```

(b) Inside the `walk(tree, [], (path, leaf) => { … })` visit callback, change how `name` and the alias `value` are derived. Replace:
```ts
      const ext = (leaf.$extensions ?? {}) as Record<string, unknown>;
      const name = path.join("/");
```
with:
```ts
      const ext = (leaf.$extensions ?? {}) as Record<string, unknown>;
      const collapsed = ext["com.figma.collapsedDefault"] === true && path[path.length - 1] === "DEFAULT";
      const name = collapsed ? path.slice(0, -1).join("/") : path.join("/");
```
Then replace the alias-value line:
```ts
      if (aliasData) {
        value = { kind: "alias", targetCollection: aliasData.targetVariableSetName, targetName: aliasData.targetVariableName };
      } else {
```
with:
```ts
      if (aliasData) {
        const rawTarget = aliasData.targetVariableName;
        const bare = rawTarget.endsWith("/DEFAULT") ? rawTarget.slice(0, -"/DEFAULT".length) : rawTarget;
        const targetName = collapsedNames.has(bare) ? bare : rawTarget;
        value = { kind: "alias", targetCollection: aliasData.targetVariableSetName, targetName };
      } else {
```

- [ ] **Step 5: Run to verify it passes.**
Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/parse.test.ts`
Expected: PASS (the 2 new tests + all existing parse tests).

- [ ] **Step 6: Typecheck + commit.**
Run: `cd /Users/christian/Dev/figma-token-export && npm run typecheck` (expect clean).
```bash
git add src/parse.ts src/parse.test.ts
git commit -m "feat(import): reverse the DEFAULT collapse on parse (restore bare names + alias targets)"
```

---

### Task 3: Round-trip a prefix collision + verify the real export

**Files:**
- Modify: `src/roundtrip.test.ts`

- [ ] **Step 1: Write the failing round-trip test.** Add to `src/roundtrip.test.ts` (inside the existing `describe("import round-trip fidelity", …)` block; it already imports `buildExport`, `parse`, `buildPlan`, `applyPlan`, `collect`, `createFakeFigma`, `canonicalize`, and defines `EMPTY`):

```ts
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
```

- [ ] **Step 2: Run to verify it fails / passes.**
Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run src/roundtrip.test.ts`
Expected: PASS once Tasks 1+2 are in. (If it FAILS on `color/white` missing → import un-rename is wrong; on `color/white/alpha/500-8` missing → export collapse is wrong. Investigate, do not weaken the assertions.)

- [ ] **Step 3: Full suite + typecheck.**
Run: `cd /Users/christian/Dev/figma-token-export && npx vitest run && npm run typecheck && npm run build`
Expected: all tests pass; typecheck clean; build succeeds.

- [ ] **Step 4: Note on real-world validation (no command).** The export zips in `token-inspector/assets/` were produced by the OLD exporter (pre-fix): they have no `com.figma.collapsedDefault` markers and their `color/white/alpha/*` were already clobbered, so they CANNOT demonstrate this fix. True real-world validation requires re-running the patched plugin inside Figma to produce a fresh export, then loading it in the inspector to confirm the `unresolved-alias` groups for `color/white|black/alpha/*` are gone. That is a user-driven Figma step, out of scope for this code change. The unit tests (Task 1, 2) + the round-trip test (Task 3) are the authoritative proof that the collapse + un-rename are correct and lossless.

- [ ] **Step 5: Commit.**
```bash
cd /Users/christian/Dev/figma-token-export
git add src/roundtrip.test.ts
git commit -m "test: round-trip a prefix-collision leaf, restoring the bare Figma name"
```

---

## Notes for the implementer
- Working directory: `/Users/christian/Dev/figma-token-export`, branch `feat/prefix-collision-default` (already checked out, holds the spec commit).
- Do NOT touch the inspector repo. Do NOT touch `figma-write.ts`, `diff.ts`, `canonical.ts`, or `collect.ts` — the fix is export + parse only.
- `findCollapsedLeaves` is O(n²) over variable names; fine at export scale (hundreds). No premature optimization.
- The `com.figma.collapsedDefault` marker MUST be set on the DEFAULT leaf for import to reverse the collapse — without it, re-import would create `color/white/DEFAULT` in Figma. The round-trip test (Task 3) is the guard.
- The live zip in Task 3 Step 4 was made by the OLD exporter; treat that step as a sanity log, not a gate. The unit + round-trip tests are the authoritative proof.
- YAGNI: one reserved key (`DEFAULT`), hardcoded; no configurability, no inspector changes, no v0.47.0 reword.
