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
      byName.set(`${col.name}\0${v.name}`, { col, v });
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

// Figma stores color channels as float32; values round-tripped through a token
// file (or hand-edited to clean decimals like 0.8) differ from the promoted
// float64 by tiny amounts. Compare within an epsilon to avoid spurious updates.
const COLOR_EPSILON = 1e-5;
function colorsEqual(a: { r: number; g: number; b: number; a?: number }, b: RGBA): boolean {
  return (
    Math.abs(a.r - b.r) < COLOR_EPSILON &&
    Math.abs(a.g - b.g) < COLOR_EPSILON &&
    Math.abs(a.b - b.b) < COLOR_EPSILON &&
    Math.abs((a.a ?? 1) - b.a) < COLOR_EPSILON
  );
}

function sameValue(
  idx: CurrentIndex,
  current: CollectedValue,
  parsed: ParsedValue,
  resolveTarget: (targetName: string, origCollection: string) => string,
): boolean {
  if (parsed.kind === "alias") {
    if (!isAlias(current)) return false;
    // If the current alias points to a variable outside the local set (e.g. a
    // library variable, which v1 does not import), it won't be in the index and
    // the value reads as changed. Acceptable: v1 handles local variables only.
    const target = idx.byId.get(current.id);
    if (!target) return false;
    return (
      target.v.name === parsed.targetName &&
      target.col.name === resolveTarget(parsed.targetName, parsed.targetCollection)
    );
  }
  if (isAlias(current)) return false;
  const pv = parsed.value;
  if (typeof pv === "number" || typeof pv === "string" || typeof pv === "boolean") return current === pv;
  if (typeof current === "object" && current !== null && "r" in current) return colorsEqual(current as RGBA, pv);
  return false;
}

function pushValueOp(
  collection: string,
  name: string,
  mode: string,
  val: ParsedValue,
  lit: ApplyOp[],
  ali: ApplyOp[],
  resolveTarget: (targetName: string, origCollection: string) => string,
): void {
  if (val.kind === "alias") {
    ali.push({
      kind: "setAlias",
      collection,
      name,
      mode,
      targetCollection: resolveTarget(val.targetName, val.targetCollection),
      targetName: val.targetName,
    });
  } else {
    lit.push({ kind: "setLiteral", collection, name, mode, value: val.value });
  }
}

export function buildPlan(parsed: ParsedModel, current: CollectedData): ImportPlan {
  const idx = indexCurrent(current);

  // Index every known variable NAME -> the collections that contain it, across
  // both the parsed model and the current Figma file. Legacy files (no
  // com.figma.collectionName) reconstruct an alias TARGET under a filename
  // fallback collection, so the alias's original collection name (from
  // aliasData) won't match — resolve the target collection by variable name.
  const colsByVarName = new Map<string, Set<string>>();
  const addVarName = (name: string, collection: string): void => {
    let set = colsByVarName.get(name);
    if (!set) {
      set = new Set();
      colsByVarName.set(name, set);
    }
    set.add(collection);
  };
  for (const pc of parsed.collections) for (const pv of pc.variables) addVarName(pv.name, pc.name);
  for (const col of current.collections) for (const v of col.variables) addVarName(v.name, col.name);

  // Prefer the original collection if it actually holds the target; else, if
  // exactly one collection holds a variable of that name, use it; otherwise
  // keep the original (figma-write will report an unresolved target).
  const resolveTarget = (targetName: string, orig: string): string => {
    const cols = colsByVarName.get(targetName);
    if (!cols || cols.size === 0) return orig;
    if (cols.has(orig)) return orig;
    if (cols.size === 1) return [...cols][0];
    return orig;
  };

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

  // Resolve each parsed variable to its EFFECTIVE collection: a variable that
  // matches an existing Figma variable keeps that variable's real collection,
  // so files whose collection names diverge from the live file (e.g. a legacy
  // fallback "Theme" vs the real "semantic") update the real variable instead
  // of spawning a duplicate collection and breaking figma-write's lookup.
  const ensuredCol = new Set<string>();
  const ensuredMode = new Set<string>();

  const ensureCollection = (name: string, firstMode: string): void => {
    if (ensuredCol.has(name)) return;
    ensuredCol.add(name);
    if (idx.collectionNames.has(name)) return; // already exists in Figma
    collectionsToCreate.push(name);
    createCollectionOps.push({ kind: "createCollection", name, firstMode });
    ensuredMode.add(`${name}\0${firstMode}`); // firstMode ships with the collection
  };

  const ensureMode = (collection: string, mode: string): void => {
    const key = `${collection}\0${mode}`;
    if (ensuredMode.has(key)) return;
    ensuredMode.add(key);
    const have = idx.modeNamesByCollection.get(collection);
    if (have && hasMode(have, mode)) return; // already present in the existing collection
    modesToAdd.push({ collection, mode });
    addModeOps.push({ kind: "addMode", collection, mode });
  };

  for (const pc of parsed.collections) {
    for (const pv of pc.variables) {
      // Figma variable ids are globally unique, so an id match is authoritative
      // even across collections; fall back to collection+name for foreign ids.
      const match =
        (pv.variableId ? idx.byId.get(pv.variableId) : undefined) ??
        idx.byName.get(`${pv.collectionName}\0${pv.name}`);
      const effCollection = match ? match.col.name : pc.name;
      const modeNames = Object.keys(pv.valuesByModeName);

      ensureCollection(effCollection, modeNames[0] ?? "Mode 1");
      for (const m of modeNames) ensureMode(effCollection, m);

      if (!match) {
        createVariableOps.push({ kind: "createVariable", collection: effCollection, name: pv.name, type: pv.resolvedType });
        const modes: string[] = [];
        for (const [mode, val] of Object.entries(pv.valuesByModeName)) {
          pushValueOp(effCollection, pv.name, mode, val, setLiteralOps, setAliasOps, resolveTarget);
          modes.push(mode);
        }
        creates.push({ collection: effCollection, name: pv.name, modes });
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
          if (cur !== undefined && sameValue(idx, cur, val, resolveTarget)) continue;
          pushValueOp(effCollection, pv.name, mode, val, setLiteralOps, setAliasOps, resolveTarget);
          changedModes.push(mode);
        }
        // Additive sync: modes/variables present only in Figma (not in the
        // parsed model) are left untouched — import never deletes.
        if (changedModes.length === 0) unchangedCount += 1;
        else updates.push({ collection: effCollection, name: pv.name, modes: changedModes });
      }
    }
  }

  // Wrong-file guard: creating variables while matching none of an existing,
  // non-empty file usually means importing into the wrong file (or one whose
  // variables were recreated) — every component bound to the existing variables
  // would keep pointing at untouched/stale variables instead of being updated.
  const allWarnings = [...parsed.warnings, ...warnings];
  const currentVarCount = current.collections.reduce((n, c) => n + c.variables.length, 0);
  if (creates.length > 0 && updates.length === 0 && unchangedCount === 0 && currentVarCount > 0) {
    allWarnings.unshift(
      `${creates.length} variables would be created but none matched the ${currentVarCount} already in this file — this looks like the wrong file, or one whose variables were recreated. Existing component bindings will not be updated.`,
    );
  }

  return {
    collectionsToCreate,
    modesToAdd,
    creates,
    updates,
    unchangedCount,
    warnings: allWarnings,
    ops: [...createCollectionOps, ...addModeOps, ...createVariableOps, ...setLiteralOps, ...setAliasOps],
  };
}
