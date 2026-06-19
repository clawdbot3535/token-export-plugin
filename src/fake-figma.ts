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
