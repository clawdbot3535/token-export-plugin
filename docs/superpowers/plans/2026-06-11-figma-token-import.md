# Figma Token Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repo → Figma import that upserts local variables (create + update, never delete), reconstructs alias bindings, reads from GitHub or a local upload, and previews a diff before applying.

**Architecture:** Mirror the existing pure-core / impure-shell split. All decisions live in pure, unit-tested modules (`format` reverse parsers, `import-mapping`, `parse`, `diff`) that emit a pre-ordered declarative op list; the impure layers (`git/github` read, `figma-write`, `main`, UI) just interpret it. A small backward-compatible export change (`com.figma.collectionName` / `modeName` / `resolvedType` in `$extensions`) lets files self-describe their collection/mode so new variables reconstruct losslessly; legacy files fall back to filename inference.

**Tech Stack:** TypeScript, Preact (`@create-figma-plugin/ui`), fflate, vitest, GitHub REST (Contents API), Figma Plugin Variables API.

**Spec:** `docs/superpowers/specs/2026-06-11-figma-token-import-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/format.ts` | modify | add `parseColor`, `parseLiteral` (reverse of `formatColor`/`formatLiteral`) |
| `src/export.ts` | modify | write 3 new `$extensions` keys per leaf |
| `src/export.test.ts` | modify | update `toEqual` expectations for new keys |
| `src/import-mapping.ts` | create | `collectionModeForFile` — filename → collection/mode fallback |
| `src/parse.ts` | create | `parse(files) → ParsedModel` — reverse of `buildExport` |
| `src/diff.ts` | create | `buildPlan(parsed, current) → ImportPlan` with ordered `ops` |
| `src/git/provider.ts` | modify | `readFiles` interface + `ReadRequest`/`ReadFile` types + `no-tokens` kind |
| `src/git/github.ts` | modify | `readFiles` via Contents API (raw accept) |
| `src/figma-write.ts` | create | `applyPlan(plan)` — interprets ops against `figma.variables.*` (impure) |
| `src/main.ts` | modify | `IMPORT_GITHUB` / `IMPORT_LOCAL` / `IMPORT_APPLY` handlers |
| `src/ui/ImportPanel.tsx` | create | import section + diff preview (impure UI) |
| `src/ui.tsx` | modify | render `<ImportPanel />` (one import + one element) |
| `README.md`, `docs/KNOWN-ISSUES.md` | modify | document import + limitations |

Test command convention: `npx vitest run <file>` for one file, `npm test` for all.

---

## Task 1: Export self-describing extension keys (Approach C)

**Files:**
- Modify: `src/export.ts:132-135` (the `extensions` object)
- Test: `src/export.test.ts` (update 3 `toEqual` blocks)

- [ ] **Step 1: Update the failing tests first**

In `src/export.test.ts`, replace the `$extensions` in the **"emits a nested color primitive"** assertion (currently lines 39-42) with:

```ts
      $extensions: {
        "com.figma.variableId": "V1",
        "com.figma.scopes": ["ALL_SCOPES"],
        "com.figma.collectionName": "primitives/color",
        "com.figma.modeName": "Mode 1",
        "com.figma.resolvedType": "COLOR",
      },
```

Replace the `$extensions` in the **"emits numeric primitives"** assertion (currently line 71) with:

```ts
      $extensions: {
        "com.figma.variableId": "V2",
        "com.figma.scopes": ["ALL_SCOPES"],
        "com.figma.collectionName": "primitives/dimension",
        "com.figma.modeName": "Mode 1",
        "com.figma.resolvedType": "FLOAT",
      },
```

Replace the `$extensions` in the **"resolves an alias to the target literal AND records aliasData (light)"** assertion (currently lines 160-167) with:

```ts
      $extensions: {
        "com.figma.variableId": "BG",
        "com.figma.scopes": ["ALL_SCOPES"],
        "com.figma.collectionName": "semantic",
        "com.figma.modeName": "light",
        "com.figma.resolvedType": "COLOR",
        "com.figma.aliasData": {
          targetVariableName: "color/white",
          targetVariableSetName: "primitives/color",
        },
      },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/export.test.ts`
Expected: FAIL — three assertions report missing `collectionName`/`modeName`/`resolvedType`.

- [ ] **Step 3: Add the keys in `buildExport`**

In `src/export.ts`, replace the `extensions` initialization (lines 132-135):

```ts
        const extensions: Record<string, unknown> = {
          "com.figma.variableId": v.id,
          "com.figma.scopes": v.scopes,
        };
```

with:

```ts
        const extensions: Record<string, unknown> = {
          "com.figma.variableId": v.id,
          "com.figma.scopes": v.scopes,
          "com.figma.collectionName": col.name,
          "com.figma.modeName": mode.name,
          "com.figma.resolvedType": v.resolvedType,
        };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/export.test.ts`
Expected: PASS (all export tests).

- [ ] **Step 5: Commit**

```bash
git add src/export.ts src/export.test.ts
git commit -m "feat: export writes collectionName/modeName/resolvedType extensions for lossless import"
```

---

## Task 2: Reverse value parsers in `format.ts`

**Files:**
- Modify: `src/format.ts` (append `parseColor`, `parseLiteral`)
- Test: `src/format.test.ts` (append describe blocks)

- [ ] **Step 1: Write the failing tests**

Append to `src/format.test.ts`. First add `parseColor, parseLiteral` to the existing import on line 2:

```ts
import { channelToHex, formatColor, formatLiteral, parseColor, parseLiteral, toHex, tokenTypeFor } from "./format";
```

Then append:

```ts
describe("parseColor", () => {
  it("reverses formatColor into RGBA", () => {
    expect(parseColor({ colorSpace: "srgb", components: [1, 1, 1], alpha: 1, hex: "#FFFFFF" })).toEqual({
      r: 1, g: 1, b: 1, a: 1,
    });
  });
  it("round-trips an arbitrary color (parse ∘ format = identity)", () => {
    const rgba = { r: 0.15, g: 0.39, b: 0.92, a: 0.5 };
    expect(parseColor(formatColor(rgba))).toEqual(rgba);
  });
});

describe("parseLiteral", () => {
  it("parses color objects to RGBA", () => {
    expect(parseLiteral({ colorSpace: "srgb", components: [0, 0, 0], alpha: 1, hex: "#000000" }, "COLOR")).toEqual({
      r: 0, g: 0, b: 0, a: 1,
    });
  });
  it("passes numbers and strings through", () => {
    expect(parseLiteral(16, "FLOAT")).toBe(16);
    expect(parseLiteral("Inter", "STRING")).toBe("Inter");
  });
  it("parses boolean strings back to boolean", () => {
    expect(parseLiteral("true", "BOOLEAN")).toBe(true);
    expect(parseLiteral("false", "BOOLEAN")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/format.test.ts`
Expected: FAIL — `parseColor`/`parseLiteral` are not exported.

- [ ] **Step 3: Implement the parsers**

Append to `src/format.ts`:

```ts
export function parseColor(c: FigmaColorValue): RGBA {
  return { r: c.components[0], g: c.components[1], b: c.components[2], a: c.alpha };
}

export function parseLiteral(value: unknown, resolved: FigmaResolvedType): number | string | boolean | RGBA {
  if (resolved === "COLOR") return parseColor(value as FigmaColorValue);
  if (resolved === "BOOLEAN") return value === "true" || value === true;
  if (resolved === "FLOAT") return Number(value);
  return String(value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts src/format.test.ts
git commit -m "feat: add parseColor/parseLiteral reverse value parsers"
```

---

## Task 3: Filename → collection/mode fallback (`import-mapping.ts`)

**Files:**
- Create: `src/import-mapping.ts`
- Test: `src/import-mapping.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/import-mapping.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/import-mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/import-mapping.ts`:

```ts
// Reverse of mapping.ts: infer a (collection, mode) bucket from a token
// filename. Used ONLY as a fallback when a leaf has no com.figma.collectionName
// / com.figma.modeName extension (i.e. files exported before Approach C).

export interface FileBucket {
  collection: string;
  /** null => single-mode file; caller substitutes the default mode name. */
  mode: string | null;
}

export function collectionModeForFile(filename: string): FileBucket {
  const f = filename.toLowerCase();
  if (f.includes("light")) return { collection: "Theme", mode: "Light" };
  if (f.includes("dark")) return { collection: "Theme", mode: "Dark" };
  if (f.includes("typography")) return { collection: "Typography", mode: null };
  if (f.includes("dimension") || f.includes("spacing")) return { collection: "Dimension", mode: null };
  if (f.includes("color")) return { collection: "Color", mode: null };
  if (f.includes("global") || f.includes("component")) return { collection: "Global", mode: null };
  const base = filename.replace(/\.tokens\.json$/i, "");
  return { collection: base || "Tokens", mode: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/import-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/import-mapping.ts src/import-mapping.test.ts
git commit -m "feat: add filename->collection/mode fallback mapping"
```

---

## Task 4: Parse token files into a model (`parse.ts`)

**Files:**
- Create: `src/parse.ts`
- Test: `src/parse.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parse } from "./parse";

function colorLeaf(opts: {
  id: string; collection: string; mode: string; hex: string;
  components?: [number, number, number]; alias?: { name: string; set: string };
}) {
  const ext: Record<string, unknown> = {
    "com.figma.variableId": opts.id,
    "com.figma.scopes": ["ALL_SCOPES"],
    "com.figma.collectionName": opts.collection,
    "com.figma.modeName": opts.mode,
    "com.figma.resolvedType": "COLOR",
  };
  if (opts.alias) ext["com.figma.aliasData"] = { targetVariableName: opts.alias.name, targetVariableSetName: opts.alias.set };
  return {
    $type: "color",
    $value: { colorSpace: "srgb", components: opts.components ?? [1, 1, 1], alpha: 1, hex: opts.hex },
    $extensions: ext,
  };
}

describe("parse", () => {
  it("parses a single literal color into one collection/variable", () => {
    const file = {
      filename: "color.tokens.json",
      json: JSON.stringify({ color: { white: colorLeaf({ id: "V1", collection: "primitives/color", mode: "Mode 1", hex: "#FFFFFF" }) } }),
    };
    const model = parse([file]);
    expect(model.warnings).toEqual([]);
    expect(model.collections).toHaveLength(1);
    expect(model.collections[0].name).toBe("primitives/color");
    expect(model.collections[0].modeNames).toEqual(["Mode 1"]);
    expect(model.collections[0].variables[0]).toEqual({
      variableId: "V1",
      collectionName: "primitives/color",
      name: "color/white",
      resolvedType: "COLOR",
      scopes: ["ALL_SCOPES"],
      valuesByModeName: { "Mode 1": { kind: "literal", value: { r: 1, g: 1, b: 1, a: 1 } } },
    });
  });

  it("merges the same variable across light/dark files into two alias modes", () => {
    const light = { filename: "light.tokens.json", json: JSON.stringify({ color: { bg: { base: colorLeaf({ id: "BG", collection: "semantic", mode: "light", hex: "#FFFFFF", alias: { name: "color/white", set: "primitives/color" } }) } } }) };
    const dark = { filename: "dark.tokens.json", json: JSON.stringify({ color: { bg: { base: colorLeaf({ id: "BG", collection: "semantic", mode: "dark", hex: "#000000", components: [0, 0, 0], alias: { name: "color/black", set: "primitives/color" } }) } } }) };
    const model = parse([light, dark]);
    expect(model.collections).toHaveLength(1);
    const v = model.collections[0].variables.find((x) => x.variableId === "BG")!;
    expect(Object.keys(v.valuesByModeName).sort()).toEqual(["dark", "light"]);
    expect(v.valuesByModeName.light).toEqual({ kind: "alias", targetCollection: "primitives/color", targetName: "color/white" });
    expect(v.valuesByModeName.dark).toEqual({ kind: "alias", targetCollection: "primitives/color", targetName: "color/black" });
    expect(model.collections[0].modeNames.sort()).toEqual(["dark", "light"]);
  });

  it("falls back to filename inference when extensions are absent (legacy file)", () => {
    const legacy = {
      filename: "color.tokens.json",
      json: JSON.stringify({ color: { white: { $type: "color", $value: { colorSpace: "srgb", components: [1, 1, 1], alpha: 1, hex: "#FFFFFF" }, $extensions: { "com.figma.variableId": "V1", "com.figma.scopes": [] } } } }),
    };
    const model = parse([legacy]);
    expect(model.collections[0].name).toBe("Color");
    expect(model.collections[0].modeNames).toEqual(["Mode 1"]);
    expect(model.collections[0].variables[0].name).toBe("color/white");
  });

  it("warns and skips a file with invalid JSON", () => {
    const model = parse([{ filename: "x.tokens.json", json: "{not json" }]);
    expect(model.collections).toEqual([]);
    expect(model.warnings[0]).toContain("invalid JSON");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/parse.ts`:

```ts
// Reverse of export.ts: walk *.tokens.json trees back into a ParsedModel.
// Self-describing extensions (com.figma.collectionName/modeName/resolvedType)
// are preferred; legacy files fall back to filename inference. The same
// variable across light/dark files merges by variableId (or collection+name).
// Pure: no figma.* / no DOM.

import { type FigmaResolvedType, parseLiteral, type RGBA } from "./format";
import { collectionModeForFile } from "./import-mapping";

export interface ImportFile {
  filename: string;
  json: string;
}

export type ParsedValue =
  | { kind: "literal"; value: number | string | boolean | RGBA }
  | { kind: "alias"; targetCollection: string; targetName: string };

export interface ParsedVariable {
  variableId?: string;
  collectionName: string;
  name: string; // slash path
  resolvedType: FigmaResolvedType;
  scopes: string[];
  valuesByModeName: Record<string, ParsedValue>;
}
export interface ParsedCollection {
  name: string;
  modeNames: string[];
  variables: ParsedVariable[];
}
export interface ParsedModel {
  collections: ParsedCollection[];
  warnings: string[];
}

interface Leaf {
  $type: string;
  $value: unknown;
  $extensions?: Record<string, unknown>;
}

function isLeaf(node: unknown): node is Leaf {
  return typeof node === "object" && node !== null && "$type" in node && "$value" in node;
}

function resolvedTypeOf(ext: Record<string, unknown>, $type: string): FigmaResolvedType {
  const fromExt = ext["com.figma.resolvedType"];
  if (fromExt === "COLOR" || fromExt === "FLOAT" || fromExt === "STRING" || fromExt === "BOOLEAN") return fromExt;
  if ($type === "color") return "COLOR";
  if ($type === "number") return "FLOAT";
  return "STRING";
}

function walk(node: Record<string, unknown>, path: string[], visit: (path: string[], leaf: Leaf) => void): void {
  for (const [key, child] of Object.entries(node)) {
    if (isLeaf(child)) visit([...path, key], child);
    else if (typeof child === "object" && child !== null) walk(child as Record<string, unknown>, [...path, key], visit);
  }
}

export function parse(files: ImportFile[]): ParsedModel {
  const warnings: string[] = [];
  const byKey = new Map<string, ParsedVariable>();
  const collectionModes = new Map<string, Set<string>>();

  for (const file of files) {
    let tree: Record<string, unknown>;
    try {
      tree = JSON.parse(file.json) as Record<string, unknown>;
    } catch {
      warnings.push(`${file.filename}: invalid JSON, skipped`);
      continue;
    }
    const fallback = collectionModeForFile(file.filename);

    walk(tree, [], (path, leaf) => {
      const ext = (leaf.$extensions ?? {}) as Record<string, unknown>;
      const name = path.join("/");
      const collectionName = (ext["com.figma.collectionName"] as string) || fallback.collection;
      const modeName = (ext["com.figma.modeName"] as string) || fallback.mode || "Mode 1";
      const resolvedType = resolvedTypeOf(ext, leaf.$type);
      const variableId = ext["com.figma.variableId"] as string | undefined;
      const scopes = (ext["com.figma.scopes"] as string[]) ?? [];
      const aliasData = ext["com.figma.aliasData"] as
        | { targetVariableName: string; targetVariableSetName: string }
        | undefined;

      let value: ParsedValue;
      if (aliasData) {
        value = { kind: "alias", targetCollection: aliasData.targetVariableSetName, targetName: aliasData.targetVariableName };
      } else {
        if (leaf.$value === null) {
          warnings.push(`${name}: null value in ${file.filename}, skipped`);
          return;
        }
        value = { kind: "literal", value: parseLiteral(leaf.$value, resolvedType) };
      }

      const key = variableId ?? `${collectionName} ${name}`;
      let pv = byKey.get(key);
      if (!pv) {
        pv = { variableId, collectionName, name, resolvedType, scopes, valuesByModeName: {} };
        byKey.set(key, pv);
      }
      pv.valuesByModeName[modeName] = value;

      let modes = collectionModes.get(collectionName);
      if (!modes) {
        modes = new Set();
        collectionModes.set(collectionName, modes);
      }
      modes.add(modeName);
    });
  }

  const byCollection = new Map<string, ParsedVariable[]>();
  for (const pv of byKey.values()) {
    let arr = byCollection.get(pv.collectionName);
    if (!arr) {
      arr = [];
      byCollection.set(pv.collectionName, arr);
    }
    arr.push(pv);
  }
  const collections: ParsedCollection[] = [];
  for (const [name, variables] of byCollection) {
    collections.push({ name, modeNames: [...(collectionModes.get(name) ?? [])], variables });
  }
  return { collections, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parse.ts src/parse.test.ts
git commit -m "feat: parse token files into a ParsedModel (reverse of buildExport)"
```

---

## Task 5: Diff parsed model against current Figma (`diff.ts`)

**Files:**
- Create: `src/diff.ts`
- Test: `src/diff.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/diff.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/diff.ts`:

```ts
// Pure planner: diff a ParsedModel against the current Figma state and emit a
// pre-ordered, declarative op list. Ordering guarantees collections and modes
// exist, then variables, then literal values, then alias bindings (two-pass).
// No figma.* access — the op list is interpreted by src/figma-write.ts.

import type {
  CollectedCollection,
  CollectedData,
  CollectedValue,
  CollectedVariable,
  VariableAliasValue,
} from "./export";
import type { FigmaResolvedType, RGBA } from "./format";
import type { ParsedModel, ParsedValue } from "./parse";

export type ApplyOp =
  | { kind: "createCollection"; name: string; firstMode: string }
  | { kind: "addMode"; collection: string; mode: string }
  | { kind: "createVariable"; collection: string; name: string; type: FigmaResolvedType }
  | { kind: "setLiteral"; collection: string; name: string; mode: string; value: number | string | boolean | RGBA }
  | { kind: "setAlias"; collection: string; name: string; mode: string; targetCollection: string; targetName: string };

export interface PlanChange {
  collection: string;
  name: string;
  modes: string[];
}
export interface ImportPlan {
  collectionsToCreate: string[];
  modesToAdd: { collection: string; mode: string }[];
  creates: PlanChange[];
  updates: PlanChange[];
  unchangedCount: number;
  warnings: string[];
  ops: ApplyOp[];
}

interface CurrentIndex {
  collectionNames: Set<string>;
  modeNamesByCollection: Map<string, Set<string>>;
  byId: Map<string, { col: CollectedCollection; v: CollectedVariable }>;
  byName: Map<string, { col: CollectedCollection; v: CollectedVariable }>;
}

function indexCurrent(current: CollectedData): CurrentIndex {
  const collectionNames = new Set<string>();
  const modeNamesByCollection = new Map<string, Set<string>>();
  const byId = new Map<string, { col: CollectedCollection; v: CollectedVariable }>();
  const byName = new Map<string, { col: CollectedCollection; v: CollectedVariable }>();
  for (const col of current.collections) {
    collectionNames.add(col.name);
    modeNamesByCollection.set(col.name, new Set(col.modes.map((m) => m.name)));
    for (const v of col.variables) {
      byId.set(v.id, { col, v });
      byName.set(`${col.name} ${v.name}`, { col, v });
    }
  }
  return { collectionNames, modeNamesByCollection, byId, byName };
}

function hasMode(set: Set<string>, mode: string): boolean {
  for (const m of set) if (m.toLowerCase() === mode.toLowerCase()) return true;
  return false;
}

function modeIdFor(col: CollectedCollection, modeName: string): string | undefined {
  const exact = col.modes.find((m) => m.name === modeName);
  if (exact) return exact.modeId;
  return col.modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase())?.modeId;
}

function isAlias(v: CollectedValue): v is VariableAliasValue {
  return typeof v === "object" && v !== null && (v as VariableAliasValue).type === "VARIABLE_ALIAS";
}

function colorsEqual(a: { r: number; g: number; b: number; a?: number }, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && (a.a ?? 1) === b.a;
}

function sameValue(idx: CurrentIndex, current: CollectedValue, parsed: ParsedValue): boolean {
  if (parsed.kind === "alias") {
    if (!isAlias(current)) return false;
    const target = idx.byId.get(current.id);
    if (!target) return false;
    return target.v.name === parsed.targetName && target.col.name === parsed.targetCollection;
  }
  if (isAlias(current)) return false;
  const pv = parsed.value;
  if (typeof pv === "number" || typeof pv === "string" || typeof pv === "boolean") return current === pv;
  if (typeof current === "object" && current !== null && "r" in current) return colorsEqual(current as RGBA, pv);
  return false;
}

function pushValueOp(collection: string, name: string, mode: string, val: ParsedValue, lit: ApplyOp[], ali: ApplyOp[]): void {
  if (val.kind === "alias") {
    ali.push({ kind: "setAlias", collection, name, mode, targetCollection: val.targetCollection, targetName: val.targetName });
  } else {
    lit.push({ kind: "setLiteral", collection, name, mode, value: val.value });
  }
}

export function buildPlan(parsed: ParsedModel, current: CollectedData): ImportPlan {
  const idx = indexCurrent(current);
  const createCollectionOps: ApplyOp[] = [];
  const addModeOps: ApplyOp[] = [];
  const createVariableOps: ApplyOp[] = [];
  const setLiteralOps: ApplyOp[] = [];
  const setAliasOps: ApplyOp[] = [];
  const collectionsToCreate: string[] = [];
  const modesToAdd: { collection: string; mode: string }[] = [];
  const creates: PlanChange[] = [];
  const updates: PlanChange[] = [];
  const warnings: string[] = [];
  let unchangedCount = 0;

  for (const pc of parsed.collections) {
    if (!idx.collectionNames.has(pc.name)) {
      const firstMode = pc.modeNames[0] ?? "Mode 1";
      collectionsToCreate.push(pc.name);
      createCollectionOps.push({ kind: "createCollection", name: pc.name, firstMode });
      for (const m of pc.modeNames.slice(1)) {
        modesToAdd.push({ collection: pc.name, mode: m });
        addModeOps.push({ kind: "addMode", collection: pc.name, mode: m });
      }
    } else {
      const have = idx.modeNamesByCollection.get(pc.name) ?? new Set<string>();
      for (const m of pc.modeNames) {
        if (!hasMode(have, m)) {
          modesToAdd.push({ collection: pc.name, mode: m });
          addModeOps.push({ kind: "addMode", collection: pc.name, mode: m });
        }
      }
    }

    for (const pv of pc.variables) {
      const match =
        (pv.variableId ? idx.byId.get(pv.variableId) : undefined) ??
        idx.byName.get(`${pv.collectionName} ${pv.name}`);

      if (!match) {
        createVariableOps.push({ kind: "createVariable", collection: pc.name, name: pv.name, type: pv.resolvedType });
        const modes: string[] = [];
        for (const [mode, val] of Object.entries(pv.valuesByModeName)) {
          pushValueOp(pc.name, pv.name, mode, val, setLiteralOps, setAliasOps);
          modes.push(mode);
        }
        creates.push({ collection: pc.name, name: pv.name, modes });
      } else {
        if (match.v.resolvedType !== pv.resolvedType) {
          warnings.push(`${pv.name}: type ${pv.resolvedType} differs from existing ${match.v.resolvedType}, skipped`);
          continue;
        }
        const changedModes: string[] = [];
        for (const [mode, val] of Object.entries(pv.valuesByModeName)) {
          const cur = (() => {
            const modeId = modeIdFor(match.col, mode);
            return modeId === undefined ? undefined : match.v.valuesByMode[modeId];
          })();
          if (cur !== undefined && sameValue(idx, cur, val)) continue;
          pushValueOp(pc.name, pv.name, mode, val, setLiteralOps, setAliasOps);
          changedModes.push(mode);
        }
        if (changedModes.length === 0) unchangedCount += 1;
        else updates.push({ collection: pc.name, name: pv.name, modes: changedModes });
      }
    }
  }

  return {
    collectionsToCreate,
    modesToAdd,
    creates,
    updates,
    unchangedCount,
    warnings: [...parsed.warnings, ...warnings],
    ops: [...createCollectionOps, ...addModeOps, ...createVariableOps, ...setLiteralOps, ...setAliasOps],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts src/diff.test.ts
git commit -m "feat: buildPlan diffs parsed tokens into an ordered apply-op list"
```

---

## Task 6: GitHub `readFiles` provider method

**Files:**
- Modify: `src/git/provider.ts` (types + interface + error kind)
- Modify: `src/git/github.ts` (`readFiles` + `callRaw`)
- Test: `src/git/github.test.ts` (append `readFiles` describe block)

- [ ] **Step 1: Extend the provider contract**

In `src/git/provider.ts`, add `"no-tokens"` to `CommitErrorKind` (line 28-33):

```ts
export type CommitErrorKind =
  | "auth"
  | "not-found"
  | "empty-repo"
  | "no-tokens"
  | "network"
  | "unexpected";
```

Append the read types and extend the interface:

```ts
export interface ReadRequest {
  owner: string;
  repo: string;
  branch: string;
  /** Repo-relative folder; "" = repo root. */
  path: string;
  token: string;
}

export interface ReadFile {
  filename: string;
  content: string;
}
```

Replace the `GitProvider` interface (lines 42-44) with:

```ts
export interface GitProvider {
  commit(req: CommitRequest): Promise<CommitResult>;
  readFiles(req: ReadRequest): Promise<ReadFile[]>;
}
```

- [ ] **Step 2: Write the failing tests**

In `src/git/github.test.ts`, extend the import on line 3:

```ts
import type { CommitRequest, ReadRequest } from "./provider";
```

Append:

```ts
function readReq(path = "tokens"): ReadRequest {
  return { owner: "me", repo: "tokens", branch: "main", path, token: "TKN" };
}

describe("createGitHubProvider.readFiles", () => {
  it("lists *.tokens.json in the folder and fetches raw content", async () => {
    const calls: Array<{ url: string; accept?: string }> = [];
    const fn = (async (url: string, init?: any): Promise<Response> => {
      calls.push({ url, accept: init?.headers?.Accept });
      if (url.includes("/contents/tokens?ref=")) {
        return new Response(
          JSON.stringify([
            { type: "file", name: "color.tokens.json", path: "tokens/color.tokens.json" },
            { type: "file", name: "README.md", path: "tokens/README.md" },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("color.tokens.json")) return new Response('{"color":{}}', { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const files = await createGitHubProvider(fn).readFiles(readReq());
    expect(files).toEqual([{ filename: "color.tokens.json", content: '{"color":{}}' }]);
    const raw = calls.find((c) => c.url.includes("color.tokens.json"))!;
    expect(raw.accept).toBe("application/vnd.github.raw");
  });

  it("throws no-tokens when the folder has no token files", async () => {
    const fn = (async () =>
      new Response(JSON.stringify([{ type: "file", name: "README.md", path: "tokens/README.md" }]), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(createGitHubProvider(fn).readFiles(readReq())).rejects.toMatchObject({ kind: "no-tokens" });
  });

  it("maps 404 to not-found", async () => {
    const fn = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(createGitHubProvider(fn).readFiles(readReq())).rejects.toMatchObject({ kind: "not-found" });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/git/github.test.ts`
Expected: FAIL — `readFiles` is not a function.

- [ ] **Step 4: Implement `readFiles` + `callRaw`**

In `src/git/github.ts`, update the import on lines 10-15 to add `ReadFile`, `ReadRequest`:

```ts
import {
  CommitError,
  type CommitRequest,
  type CommitResult,
  type GitProvider,
  type ReadFile,
  type ReadRequest,
} from "./provider";
```

Inside `createGitHubProvider`, after the `call` function (after line 63), add `callRaw`:

```ts
  async function callRaw(url: string, token: string): Promise<string> {
    let res: Response;
    try {
      res = await fetchFn(url, { method: "GET", headers: { ...headers(token), Accept: "application/vnd.github.raw" } });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new CommitError("network", `Network error reaching api.github.com: ${msg}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw mapHttpError(res.status, text);
    }
    return res.text();
  }
```

In the returned object, add `readFiles` alongside `commit` (after the `commit` method's closing `},` near line 127):

```ts
    async readFiles(req: ReadRequest): Promise<ReadFile[]> {
      const base = `${API}/repos/${req.owner}/${req.repo}`;
      const ref = encodeURIComponent(req.branch);
      const dirUrl = req.path ? `${base}/contents/${req.path}?ref=${ref}` : `${base}/contents?ref=${ref}`;
      const listing = await call("GET", dirUrl, req.token);
      if (!Array.isArray(listing)) {
        throw new CommitError("not-found", "Configured token path is a file, not a folder");
      }
      const entries = (listing as Array<{ type: string; name: string; path: string }>).filter(
        (e) => e.type === "file" && e.name.endsWith(".tokens.json"),
      );
      if (entries.length === 0) {
        throw new CommitError("no-tokens", "No *.tokens.json files found at the configured path");
      }
      const files: ReadFile[] = [];
      for (const e of entries) {
        const content = await callRaw(`${base}/contents/${e.path}?ref=${ref}`, req.token);
        files.push({ filename: e.name, content });
      }
      return files;
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/git/github.test.ts`
Expected: PASS (commit + readFiles tests).

- [ ] **Step 6: Commit**

```bash
git add src/git/provider.ts src/git/github.ts src/git/github.test.ts
git commit -m "feat: GitHub readFiles reads *.tokens.json via Contents API (raw)"
```

---

## Task 7: Apply the plan to Figma (`figma-write.ts`)

**Files:**
- Create: `src/figma-write.ts`

> Impure (uses the `figma` global) — not unit-tested, same posture as `collectData` in `main.ts`. Verified via `npm run build` typecheck here and manual QA in Task 10.

- [ ] **Step 1: Implement**

Create `src/figma-write.ts`:

```ts
// Impure: interprets a diff.ts ImportPlan against figma.variables.*. Keeps
// name->collection / name->variable maps as it creates things, so later
// setAlias ops resolve their targets. No decision logic lives here.

import type { ApplyOp, ImportPlan } from "./diff";

export interface ApplySummary {
  createdCollections: number;
  createdVariables: number;
  updatedVariables: number;
  errors: string[];
}

export async function applyPlan(plan: ImportPlan): Promise<ApplySummary> {
  const summary: ApplySummary = { createdCollections: 0, createdVariables: 0, updatedVariables: 0, errors: [] };
  const colByName = new Map<string, VariableCollection>();
  const varByKey = new Map<string, Variable>(); // `${collection} ${name}`
  const createdKeys = new Set<string>();
  const touched = new Set<string>();

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const col of collections) {
    colByName.set(col.name, col);
    for (const id of col.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v) varByKey.set(`${col.name} ${v.name}`, v);
    }
  }

  function modeId(col: VariableCollection, modeName: string): string {
    const exact = col.modes.find((m) => m.name === modeName);
    if (exact) return exact.modeId;
    const ci = col.modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase());
    return (ci ?? col.modes[0]).modeId;
  }

  function opName(op: ApplyOp): string {
    return "name" in op ? op.name : "";
  }

  for (const op of plan.ops) {
    try {
      if (op.kind === "createCollection") {
        const col = figma.variables.createVariableCollection(op.name);
        col.renameMode(col.modes[0].modeId, op.firstMode);
        colByName.set(op.name, col);
        summary.createdCollections += 1;
      } else if (op.kind === "addMode") {
        const col = colByName.get(op.collection);
        if (col && !col.modes.some((m) => m.name.toLowerCase() === op.mode.toLowerCase())) col.addMode(op.mode);
      } else if (op.kind === "createVariable") {
        const col = colByName.get(op.collection);
        if (!col) {
          summary.errors.push(`${op.name}: collection ${op.collection} not available`);
          continue;
        }
        const v = figma.variables.createVariable(op.name, col, op.type);
        const key = `${op.collection} ${op.name}`;
        varByKey.set(key, v);
        createdKeys.add(key);
      } else if (op.kind === "setLiteral") {
        const v = varByKey.get(`${op.collection} ${op.name}`);
        const col = colByName.get(op.collection);
        if (!v || !col) {
          summary.errors.push(`${op.name}: missing variable/collection for setLiteral`);
          continue;
        }
        v.setValueForMode(modeId(col, op.mode), op.value as VariableValue);
        touched.add(`${op.collection} ${op.name}`);
      } else if (op.kind === "setAlias") {
        const v = varByKey.get(`${op.collection} ${op.name}`);
        const col = colByName.get(op.collection);
        const target = varByKey.get(`${op.targetCollection} ${op.targetName}`);
        if (!v || !col) {
          summary.errors.push(`${op.name}: missing variable/collection for setAlias`);
          continue;
        }
        if (!target) {
          summary.errors.push(`${op.name}: alias target ${op.targetCollection}/${op.targetName} not found`);
          continue;
        }
        v.setValueForMode(modeId(col, op.mode), figma.variables.createVariableAlias(target));
        touched.add(`${op.collection} ${op.name}`);
      }
    } catch (err) {
      summary.errors.push(`${op.kind} ${opName(op)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  summary.createdVariables = createdKeys.size;
  summary.updatedVariables = [...touched].filter((k) => !createdKeys.has(k)).length;
  return summary;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors). If the installed `@figma/plugin-typings` requires `createVariable(name, collectionId, type)` instead of the collection object, change `figma.variables.createVariable(op.name, col, op.type)` to `figma.variables.createVariable(op.name, col.id, op.type)`.

- [ ] **Step 3: Commit**

```bash
git add src/figma-write.ts
git commit -m "feat: applyPlan writes collections/variables/aliases into Figma"
```

---

## Task 8: Wire import handlers into `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add imports**

In `src/main.ts`, after the existing imports (line 11), add:

```ts
import { buildPlan, type ImportPlan } from "./diff";
import { applyPlan } from "./figma-write";
import { type ImportFile, parse } from "./parse";
```

- [ ] **Step 2: Add module-level helpers**

After `loadSettings` (after line 48), add:

```ts
function planSummary(plan: ImportPlan) {
  return {
    creates: plan.creates.length,
    updates: plan.updates.length,
    unchanged: plan.unchangedCount,
    collectionsToCreate: plan.collectionsToCreate,
    modesToAdd: plan.modesToAdd,
    createNames: plan.creates.map((c) => `${c.collection}/${c.name}`),
    updateNames: plan.updates.map((c) => `${c.collection}/${c.name}`),
    warnings: plan.warnings,
  };
}

function importError(err: unknown): { kind: string; message: string } {
  if (err instanceof CommitError) return { kind: err.kind, message: err.message };
  return { kind: "unexpected", message: err instanceof Error ? err.message : String(err) };
}
```

- [ ] **Step 3: Register the handlers**

Inside the default exported function, after the `showUI` / `loadSettings` calls (after line 53), add the import-state closure variable and the three handlers:

```ts
  let lastImportFiles: ImportFile[] | null = null;

  on("IMPORT_GITHUB", async function () {
    const settings = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Settings | undefined;
    const token = (await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined;
    if (!settings || !token) {
      emit("IMPORT_ERROR", { kind: "auth", message: "Configure repo settings and a token first" });
      return;
    }
    try {
      const read = await createGitHubProvider().readFiles({
        owner: settings.owner,
        repo: settings.repo,
        branch: settings.branch,
        path: normalizePath(settings.path),
        token,
      });
      const files: ImportFile[] = read.map((r) => ({ filename: r.filename, json: r.content }));
      lastImportFiles = files;
      const plan = buildPlan(parse(files), await collectData());
      emit("IMPORT_PLAN", planSummary(plan));
    } catch (err) {
      emit("IMPORT_ERROR", importError(err));
    }
  });

  on("IMPORT_LOCAL", async function (payload: { files: ImportFile[] }) {
    try {
      lastImportFiles = payload.files;
      const plan = buildPlan(parse(payload.files), await collectData());
      emit("IMPORT_PLAN", planSummary(plan));
    } catch (err) {
      emit("IMPORT_ERROR", importError(err));
    }
  });

  on("IMPORT_APPLY", async function () {
    if (!lastImportFiles) {
      emit("IMPORT_ERROR", { kind: "unexpected", message: "Nothing to apply — preview first" });
      return;
    }
    try {
      const plan = buildPlan(parse(lastImportFiles), await collectData());
      const summary = await applyPlan(plan);
      emit("IMPORT_DONE", summary);
    } catch (err) {
      emit("IMPORT_ERROR", importError(err));
    }
  });
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: main.ts import handlers (github/local preview + apply)"
```

---

## Task 9: Import UI panel

**Files:**
- Create: `src/ui/ImportPanel.tsx`
- Modify: `src/ui.tsx`

- [ ] **Step 1: Create the panel**

Create `src/ui/ImportPanel.tsx`:

```tsx
import { Button, Text, VerticalSpace } from "@create-figma-plugin/ui";
import { emit, on } from "@create-figma-plugin/utilities";
import { strFromU8, unzipSync } from "fflate";
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ImportFile } from "../parse";

interface PlanSummary {
  creates: number;
  updates: number;
  unchanged: number;
  collectionsToCreate: string[];
  modesToAdd: { collection: string; mode: string }[];
  createNames: string[];
  updateNames: string[];
  warnings: string[];
}

interface DoneSummary {
  createdCollections: number;
  createdVariables: number;
  updatedVariables: number;
  errors: string[];
}

export function ImportPanel() {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [status, setStatus] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offPlan = on("IMPORT_PLAN", (p: PlanSummary) => {
      setPlan(p);
      const warn = p.warnings.length ? ` · ${p.warnings.length} warnings` : "";
      setStatus(`${p.creates} new · ${p.updates} changed · ${p.unchanged} unchanged${warn}`);
    });
    const offDone = on("IMPORT_DONE", (s: DoneSummary) => {
      setPlan(null);
      const errs = s.errors.length ? ` · ${s.errors.length} errors` : "";
      setStatus(`Imported: +${s.createdVariables} vars, ${s.updatedVariables} updated, +${s.createdCollections} collections${errs}`);
    });
    const offErr = on("IMPORT_ERROR", (p: { kind: string; message: string }) => {
      setPlan(null);
      setStatus(`Import error (${p.kind}): ${p.message}`);
    });
    return () => {
      offPlan();
      offDone();
      offErr();
    };
  }, []);

  async function onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const list = input.files;
    if (!list || list.length === 0) return;
    const files: ImportFile[] = [];
    for (const f of Array.from(list)) {
      const buf = new Uint8Array(await f.arrayBuffer());
      if (f.name.endsWith(".zip")) {
        const unzipped = unzipSync(buf);
        for (const [name, bytes] of Object.entries(unzipped)) {
          if (name.endsWith(".tokens.json")) files.push({ filename: name.split("/").pop() as string, json: strFromU8(bytes) });
        }
      } else if (f.name.endsWith(".json")) {
        files.push({ filename: f.name, json: strFromU8(buf) });
      }
    }
    input.value = "";
    if (files.length === 0) {
      setStatus("No *.tokens.json found in selection");
      return;
    }
    setStatus("Reading files…");
    emit("IMPORT_LOCAL", { files });
  }

  return (
    <div>
      <Text>Import from repo</Text>
      <VerticalSpace space="small" />
      <Button
        secondary
        fullWidth
        onClick={() => {
          setStatus("Reading from GitHub…");
          emit("IMPORT_GITHUB");
        }}
      >
        Preview from GitHub
      </Button>
      <VerticalSpace space="small" />
      <Button secondary fullWidth onClick={() => fileRef.current?.click()}>
        Preview from file…
      </Button>
      <input ref={fileRef} type="file" accept=".zip,.json" multiple style={{ display: "none" }} onChange={onFiles} />
      {plan ? (
        <div>
          <VerticalSpace space="small" />
          <Text>
            {plan.creates} new, {plan.updates} changed, {plan.unchanged} unchanged
          </Text>
          <VerticalSpace space="small" />
          <Button
            fullWidth
            onClick={() => {
              setStatus("Applying…");
              emit("IMPORT_APPLY");
            }}
          >
            Apply to Figma
          </Button>
          <VerticalSpace space="small" />
          <Button
            secondary
            fullWidth
            onClick={() => {
              setPlan(null);
              setStatus("Cancelled");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      <VerticalSpace space="small" />
      <Text>{status}</Text>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `ui.tsx`**

In `src/ui.tsx`, add to the imports (after line 8):

```ts
import { ImportPanel } from "./ui/ImportPanel";
```

Then, inside the returned `<Container>`, replace the final status line (line 113-114):

```tsx
      <VerticalSpace space="small" />
      <Text>{status}</Text>
```

with:

```tsx
      <VerticalSpace space="small" />
      <Text>{status}</Text>
      <VerticalSpace space="medium" />
      <ImportPanel />
    </Container>
```

(Remove the now-duplicated `</Container>` that previously closed the JSX — the closing tag is moved into the block above. Verify only one `</Container>` remains.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/ImportPanel.tsx src/ui.tsx
git commit -m "feat: import panel UI with diff preview and apply"
```

---

## Task 10: Build, docs, manual QA

**Files:**
- Modify: `README.md`, `docs/KNOWN-ISSUES.md`
- Build artifacts: `manifest.json`, `build/`

- [ ] **Step 1: Full test + build**

Run: `npm test`
Expected: PASS (all suites: format, mapping, import-mapping, parse, diff, export, github, settings, timestamp).

Run: `npm run build`
Expected: typecheck passes; regenerates `manifest.json` + `build/main.js` + `build/ui.js`.

- [ ] **Step 2: Update README**

In `README.md`, under **Limitations (v1)**, remove the phrase "and pulling tokens back into Figma are not implemented" from the GitHub bullet (it is now implemented).

Add a new section after **Commit to GitHub**:

```markdown
## Import (repo → Figma)

Pull tokens back into the current Figma file:

1. **Preview from GitHub** — reads `*.tokens.json` from the configured
   owner/repo/branch/path (PAT needs **Contents: read**, covered by the write
   scope), or **Preview from file…** to pick a `tokens.zip` / `.json` files.
2. Review the diff (new / changed / unchanged counts + warnings).
3. **Apply to Figma** — existing variables are updated in place (matched by
   `com.figma.variableId`, then collection+name); missing ones are created;
   alias relationships are reconstructed. Nothing is deleted. Use **Cmd+Z** to undo.

Exports now embed `com.figma.collectionName` / `modeName` / `resolvedType` in each
token's `$extensions` so a round-trip reconstructs collections, modes, and booleans
losslessly. Files exported by older versions still import via filename inference.
```

- [ ] **Step 3: Note the fallback in KNOWN-ISSUES**

Append to `docs/KNOWN-ISSUES.md`:

```markdown
## Import: legacy files without self-describing extensions

Token files exported before the import feature lack
`com.figma.collectionName` / `modeName` / `resolvedType`. On import these fall back
to filename-based collection/mode inference (e.g. `light.tokens.json` → a `Theme`
collection's `Light` mode), and BOOLEAN variables reconstruct as strings. Re-export
once with the current version to make future round-trips lossless.
```

- [ ] **Step 4: Manual QA in Figma (checklist)**

In the Figma desktop app: Quick Actions → `Import plugin from manifest…` → select `manifest.json`, then verify:

- [ ] Export a file, edit a color value in the repo, **Preview from GitHub** → shows 1 changed → **Apply** → Figma variable updates; Cmd+Z reverts.
- [ ] **Preview from file…** with the exported `tokens.zip` on the same file → all unchanged.
- [ ] Import the zip into a **new empty** Figma file → collections/modes/variables created; semantic aliases point at primitives (not flattened literals).
- [ ] Folder with no `*.tokens.json` → status shows `Import error (no-tokens)`.
- [ ] Save settings with a bad repo name → **Preview from GitHub** shows `not-found`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/KNOWN-ISSUES.md manifest.json build/
git commit -m "docs: document token import; build import feature"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** upsert (Tasks 4-5,7), alias reconstruct (parse alias + diff setAlias + figma-write createVariableAlias), both sources (Task 6 GitHub + Task 9 local), diff-then-apply (Tasks 5,8,9), no deletion (no delete op exists), Approach C export keys (Task 1). All covered.
- **Type consistency:** `ImportFile` (parse.ts) is the single file shape used by main + UI; `ReadFile` (provider) is mapped to `ImportFile` in `IMPORT_GITHUB`. `ApplyOp`/`ImportPlan` defined in diff.ts, consumed unchanged by figma-write.ts and main.ts. `ParsedValue` literal type `number|string|boolean|RGBA` matches `parseLiteral`'s return and `setLiteral.value`.
- **Boundary:** `figma-write.ts` and `main.ts` are the only impure modules; everything decision-bearing is pure and unit-tested.
