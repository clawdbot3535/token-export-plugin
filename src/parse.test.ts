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

  it("warns and skips a FLOAT leaf with a non-numeric value", () => {
    const bad = {
      filename: "dimension.tokens.json",
      json: JSON.stringify({ spacing: { x: { $type: "number", $value: "abc", $extensions: { "com.figma.variableId": "V9", "com.figma.scopes": [], "com.figma.collectionName": "primitives/dimension", "com.figma.modeName": "Mode 1", "com.figma.resolvedType": "FLOAT" } } } }),
    };
    const model = parse([bad]);
    expect(model.warnings.some((w) => w.includes("spacing/x"))).toBe(true);
    expect(model.collections).toEqual([]);
  });

  it("infers BOOLEAN from a W3C $type:boolean leaf without a resolvedType extension", () => {
    const file = {
      filename: "flags.tokens.json",
      json: JSON.stringify({ flag: { on: { $type: "boolean", $value: "true", $extensions: { "com.figma.variableId": "B1", "com.figma.scopes": [] } } } }),
    };
    const model = parse([file]);
    expect(model.collections[0].variables[0].resolvedType).toBe("BOOLEAN");
    expect(model.collections[0].variables[0].valuesByModeName["Mode 1"]).toEqual({ kind: "literal", value: true });
  });

  it("warns and skips a leaf with a null value", () => {
    const file = {
      filename: "color.tokens.json",
      json: JSON.stringify({ color: { x: { $type: "color", $value: null, $extensions: { "com.figma.variableId": "X", "com.figma.scopes": [], "com.figma.collectionName": "primitives/color", "com.figma.modeName": "Mode 1", "com.figma.resolvedType": "COLOR" } } } }),
    };
    const model = parse([file]);
    expect(model.warnings.some((w) => w.includes("color/x"))).toBe(true);
    expect(model.collections).toEqual([]);
  });
});
