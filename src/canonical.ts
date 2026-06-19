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
        // Omit an emptied $extensions entirely, so a leaf whose only extensions
        // were stripped compares equal to one that never carried $extensions.
        if (Object.keys(cleanedExt).length > 0) out[key] = cleanedExt;
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
