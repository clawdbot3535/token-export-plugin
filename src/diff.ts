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
        idx.byName.get(`${pv.collectionName}\0${pv.name}`);

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
