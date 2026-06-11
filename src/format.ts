// Pure value formatters: Figma variable values -> the JSON shapes the
// token-inspector expects (REST-compatible). No figma.* access.

export type FigmaResolvedType = "BOOLEAN" | "COLOR" | "FLOAT" | "STRING";

export interface RGB { r: number; g: number; b: number }
export interface RGBA extends RGB { a: number }

/** Inspector token $type vocabulary used in the reference exports. */
export type TokenType = "color" | "number" | "string";

export interface FigmaColorValue {
  colorSpace: "srgb";
  components: [number, number, number];
  alpha: number;
  hex: string;
}

export function channelToHex(n: number): string {
  const clamped = Math.max(0, Math.min(1, n));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

export function toHex(c: RGB | RGBA): string {
  return `#${channelToHex(c.r)}${channelToHex(c.g)}${channelToHex(c.b)}`;
}

export function formatColor(c: RGB | RGBA): FigmaColorValue {
  const alpha = "a" in c ? c.a : 1;
  return {
    colorSpace: "srgb",
    components: [c.r, c.g, c.b],
    alpha,
    hex: toHex(c),
  };
}

export function tokenTypeFor(resolved: FigmaResolvedType): TokenType {
  switch (resolved) {
    case "COLOR":
      return "color";
    case "FLOAT":
      return "number";
    default:
      return "string"; // STRING and BOOLEAN
  }
}

export function formatLiteral(value: unknown, resolved: FigmaResolvedType): unknown {
  if (resolved === "COLOR") return formatColor(value as RGB | RGBA);
  if (resolved === "BOOLEAN") return String(value);
  return value; // FLOAT -> number, STRING -> string
}

export function parseColor(c: FigmaColorValue): RGBA {
  return { r: c.components[0], g: c.components[1], b: c.components[2], a: c.alpha };
}

export function parseLiteral(value: unknown, resolved: FigmaResolvedType): number | string | boolean | RGBA {
  if (resolved === "COLOR") return parseColor(value as FigmaColorValue);
  if (resolved === "BOOLEAN") return value === "true" || value === true;
  if (resolved === "FLOAT") return Number(value);
  return String(value);
}
