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
