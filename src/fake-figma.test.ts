import { describe, expect, it } from "vitest";
import { createFakeFigma } from "./fake-figma";

describe("createFakeFigma", () => {
  it("creates a collection with one default mode and renames it", () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("primitives");
    expect(col.modes).toHaveLength(1);
    col.renameMode(col.modes[0].modeId, "Light");
    expect(col.modes[0].name).toBe("Light");
    col.addMode("Dark");
    expect(col.modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
  });

  it("createVariable registers into the collection and the id index immediately", async () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("primitives");
    const v = fake.figma.variables.createVariable("color/blue", col, "COLOR");
    expect(col.variableIds).toContain(v.id);
    const fetched = await fake.figma.variables.getVariableByIdAsync(v.id);
    expect(fetched?.name).toBe("color/blue");
    expect(fetched?.resolvedType).toBe("COLOR");
    expect(fetched?.scopes).toEqual([]);
  });

  it("setValueForMode stores values and getLocalVariableCollectionsAsync reflects them", async () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("c");
    const m = col.modes[0].modeId;
    const v = fake.figma.variables.createVariable("n", col, "FLOAT");
    v.setValueForMode(m, 4);
    const cols = await fake.figma.variables.getLocalVariableCollectionsAsync();
    const got = await fake.figma.variables.getVariableByIdAsync(cols[0].variableIds[0]);
    expect(got?.valuesByMode[m]).toBe(4);
  });

  it("createVariableAlias returns a VARIABLE_ALIAS pointing at the target id", () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("c");
    const target = fake.figma.variables.createVariable("t", col, "COLOR");
    const alias = fake.figma.variables.createVariableAlias(target);
    expect(alias).toEqual({ type: "VARIABLE_ALIAS", id: target.id });
  });

  it("mints a fresh id per created variable", () => {
    const fake = createFakeFigma();
    const col = fake.figma.variables.createVariableCollection("c");
    const a = fake.figma.variables.createVariable("a", col, "STRING");
    const b = fake.figma.variables.createVariable("b", col, "STRING");
    expect(a.id).not.toBe(b.id);
  });
});
