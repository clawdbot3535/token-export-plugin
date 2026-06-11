import { describe, expect, it } from "vitest";
import { channelToHex, formatColor, formatLiteral, parseColor, parseLiteral, toHex, tokenTypeFor } from "./format";

describe("channelToHex", () => {
  it("converts 0..1 float channels to 2-digit uppercase hex", () => {
    expect(channelToHex(1)).toBe("FF");
    expect(channelToHex(0)).toBe("00");
    expect(channelToHex(0.5)).toBe("80");
  });
  it("clamps out-of-range input", () => {
    expect(channelToHex(2)).toBe("FF");
    expect(channelToHex(-1)).toBe("00");
  });
});

describe("toHex", () => {
  it("builds #RRGGBB ignoring alpha", () => {
    expect(toHex({ r: 1, g: 1, b: 1, a: 0.5 })).toBe("#FFFFFF");
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
  });
});

describe("formatColor", () => {
  it("produces the inspector color object with srgb space and alpha default 1", () => {
    expect(formatColor({ r: 1, g: 1, b: 1 })).toEqual({
      colorSpace: "srgb",
      components: [1, 1, 1],
      alpha: 1,
      hex: "#FFFFFF",
    });
  });
  it("preserves explicit alpha and raw component floats", () => {
    expect(formatColor({ r: 0.15, g: 0.39, b: 0.92, a: 0.5 })).toEqual({
      colorSpace: "srgb",
      components: [0.15, 0.39, 0.92],
      alpha: 0.5,
      hex: "#2663EB",
    });
  });
});

describe("tokenTypeFor", () => {
  it("maps Figma resolved types to inspector $type", () => {
    expect(tokenTypeFor("COLOR")).toBe("color");
    expect(tokenTypeFor("FLOAT")).toBe("number");
    expect(tokenTypeFor("STRING")).toBe("string");
    expect(tokenTypeFor("BOOLEAN")).toBe("string");
  });
});

describe("formatLiteral", () => {
  it("formats colors as objects", () => {
    expect(formatLiteral({ r: 0, g: 0, b: 0 }, "COLOR")).toEqual({
      colorSpace: "srgb",
      components: [0, 0, 0],
      alpha: 1,
      hex: "#000000",
    });
  });
  it("passes numbers and strings through", () => {
    expect(formatLiteral(16, "FLOAT")).toBe(16);
    expect(formatLiteral("Inter", "STRING")).toBe("Inter");
  });
  it("stringifies booleans", () => {
    expect(formatLiteral(true, "BOOLEAN")).toBe("true");
  });
});

describe("parseColor", () => {
  it("reverses formatColor into RGBA", () => {
    expect(parseColor({ colorSpace: "srgb", components: [1, 1, 1], alpha: 1, hex: "#FFFFFF" })).toEqual({
      r: 1, g: 1, b: 1, a: 1,
    });
  });
  it("round-trips an arbitrary color (parse ∘ format = identity)", () => {
    const rgba = { r: 0.15, g: 0.39, b: 0.92, a: 0.5 };
    expect(parseColor(formatColor(rgba))).toEqual(rgba);
  });
});

describe("parseLiteral", () => {
  it("parses color objects to RGBA", () => {
    expect(parseLiteral({ colorSpace: "srgb", components: [0, 0, 0], alpha: 1, hex: "#000000" }, "COLOR")).toEqual({
      r: 0, g: 0, b: 0, a: 1,
    });
  });
  it("passes numbers and strings through", () => {
    expect(parseLiteral(16, "FLOAT")).toBe(16);
    expect(parseLiteral("Inter", "STRING")).toBe("Inter");
  });
  it("parses boolean strings back to boolean", () => {
    expect(parseLiteral("true", "BOOLEAN")).toBe(true);
    expect(parseLiteral("false", "BOOLEAN")).toBe(false);
  });
});
