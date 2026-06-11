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
  const varByKey = new Map<string, Variable>(); // `${collection}\0${name}`
  const createdKeys = new Set<string>();
  const touched = new Set<string>();

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const col of collections) {
    colByName.set(col.name, col);
    for (const id of col.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v) varByKey.set(`${col.name}\0${v.name}`, v);
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
        const key = `${op.collection}\0${op.name}`;
        varByKey.set(key, v);
        createdKeys.add(key);
      } else if (op.kind === "setLiteral") {
        const v = varByKey.get(`${op.collection}\0${op.name}`);
        const col = colByName.get(op.collection);
        if (!v || !col) {
          summary.errors.push(`${op.name}: missing variable/collection for setLiteral`);
          continue;
        }
        v.setValueForMode(modeId(col, op.mode), op.value as VariableValue);
        touched.add(`${op.collection}\0${op.name}`);
      } else if (op.kind === "setAlias") {
        const v = varByKey.get(`${op.collection}\0${op.name}`);
        const col = colByName.get(op.collection);
        const target = varByKey.get(`${op.targetCollection}\0${op.targetName}`);
        if (!v || !col) {
          summary.errors.push(`${op.name}: missing variable/collection for setAlias`);
          continue;
        }
        if (!target) {
          summary.errors.push(`${op.name}: alias target ${op.targetCollection}/${op.targetName} not found`);
          continue;
        }
        v.setValueForMode(modeId(col, op.mode), figma.variables.createVariableAlias(target));
        touched.add(`${op.collection}\0${op.name}`);
      }
    } catch (err) {
      summary.errors.push(`${op.kind} ${opName(op)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  summary.createdVariables = createdKeys.size;
  summary.updatedVariables = [...touched].filter((k) => !createdKeys.has(k)).length;
  return summary;
}
