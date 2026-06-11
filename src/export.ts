// Pure builder: plain collected variable data -> { filename, json }[] in the
// REST-compatible shape the token-inspector ingests. No figma.* / no DOM.

import { type FigmaResolvedType, formatLiteral, type TokenType, tokenTypeFor } from "./format";
import { filenameFor } from "./mapping";

export interface VariableAliasValue {
  type: "VARIABLE_ALIAS";
  id: string;
}
export type CollectedValue =
  | boolean
  | number
  | string
  | { r: number; g: number; b: number; a?: number }
  | VariableAliasValue;

export interface CollectedVariable {
  id: string;
  name: string; // slash path, e.g. "color/bg/base"
  resolvedType: FigmaResolvedType;
  valuesByMode: Record<string, CollectedValue>;
  scopes: string[];
  collectionId: string;
}
export interface CollectedMode {
  modeId: string;
  name: string;
}
export interface CollectedCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: CollectedMode[];
  variables: CollectedVariable[];
}
export interface CollectedData {
  collections: CollectedCollection[];
}

export interface ExportFile {
  filename: string;
  json: string;
}
export interface ExportResult {
  files: ExportFile[];
  warnings: string[];
}

interface TokenLeaf {
  $type: TokenType;
  $value: unknown;
  $extensions: Record<string, unknown>;
}

function isAlias(v: CollectedValue): v is VariableAliasValue {
  return typeof v === "object" && v !== null && (v as VariableAliasValue).type === "VARIABLE_ALIAS";
}

function setNested(root: Record<string, unknown>, path: string[], leaf: TokenLeaf): void {
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]] = leaf;
}

interface ResolveCtx {
  idToVar: Map<string, CollectedVariable>;
  idToCol: Map<string, CollectedCollection>;
}

/** Pick the target collection's modeId matching the consuming mode name,
 *  else its default mode, else its first mode. */
function resolveModeId(col: CollectedCollection, modeName: string): string {
  const byName = col.modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase());
  if (byName) return byName.modeId;
  const def = col.modes.find((m) => m.modeId === col.defaultModeId);
  return (def ?? col.modes[0]).modeId;
}

/** Follow an alias chain to a final literal for the given consuming mode. */
function resolveLiteral(
  value: CollectedValue,
  resolvedType: FigmaResolvedType,
  modeName: string,
  ctx: ResolveCtx,
  seen: Set<string>,
): unknown {
  if (!isAlias(value)) return formatLiteral(value, resolvedType);
  if (seen.has(value.id)) return null; // cycle guard
  seen.add(value.id);
  const target = ctx.idToVar.get(value.id);
  if (!target) return null;
  const col = ctx.idToCol.get(target.collectionId);
  if (!col) return null;
  const next = target.valuesByMode[resolveModeId(col, modeName)];
  if (next === undefined) return null;
  return resolveLiteral(next, target.resolvedType, modeName, ctx, seen);
}

export function buildExport(data: CollectedData): ExportResult {
  const warnings: string[] = [];
  const fileTrees = new Map<string, Record<string, unknown>>();

  const idToVar = new Map<string, CollectedVariable>();
  const idToCol = new Map<string, CollectedCollection>();
  for (const col of data.collections) {
    idToCol.set(col.id, col);
    for (const v of col.variables) idToVar.set(v.id, v);
  }
  const ctx: ResolveCtx = { idToVar, idToCol };

  for (const col of data.collections) {
    for (const mode of col.modes) {
      const filename = filenameFor(col.name, mode.name, col.modes.length);
      let tree = fileTrees.get(filename);
      if (!tree) {
        tree = {};
        fileTrees.set(filename, tree);
      }

      for (const v of col.variables) {
        const raw = v.valuesByMode[mode.modeId];
        if (raw === undefined) {
          warnings.push(`${v.name}: no value for mode "${mode.name}"`);
          continue;
        }

        const extensions: Record<string, unknown> = {
          "com.figma.variableId": v.id,
          "com.figma.scopes": v.scopes,
          "com.figma.collectionName": col.name,
          "com.figma.modeName": mode.name,
          "com.figma.resolvedType": v.resolvedType,
        };

        let value: unknown;
        if (isAlias(raw)) {
          value = resolveLiteral(raw, v.resolvedType, mode.name, ctx, new Set());
          if (value === null) {
            warnings.push(`${v.name}: unresolvable alias in mode "${mode.name}"`);
          }
          const target = ctx.idToVar.get(raw.id);
          if (target) {
            extensions["com.figma.aliasData"] = {
              targetVariableName: target.name,
              targetVariableSetName: ctx.idToCol.get(target.collectionId)?.name ?? "",
            };
          }
        } else {
          value = formatLiteral(raw, v.resolvedType);
        }

        const leaf: TokenLeaf = {
          $type: tokenTypeFor(v.resolvedType),
          $value: value,
          $extensions: extensions,
        };
        setNested(tree, v.name.split("/"), leaf);
      }
    }
  }

  const files: ExportFile[] = [...fileTrees].map(([filename, tree]) => ({
    filename,
    json: JSON.stringify(tree, null, 2),
  }));
  return { files, warnings };
}
