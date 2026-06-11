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
  if ($type === "boolean") return "BOOLEAN";
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
        const literal = parseLiteral(leaf.$value, resolvedType);
        if (resolvedType === "FLOAT" && typeof literal === "number" && Number.isNaN(literal)) {
          warnings.push(`${name}: non-numeric FLOAT value in ${file.filename}, skipped`);
          return;
        }
        value = { kind: "literal", value: literal };
      }

      const key = variableId ?? `${collectionName}\0${name}`;
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
