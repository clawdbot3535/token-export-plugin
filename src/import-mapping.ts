// Reverse of mapping.ts: infer a (collection, mode) bucket from a token
// filename. Used ONLY as a fallback when a leaf has no com.figma.collectionName
// / com.figma.modeName extension (i.e. files exported before Approach C).

export interface FileBucket {
  collection: string;
  /** null => single-mode file; caller substitutes the default mode name. */
  mode: string | null;
}

export function collectionModeForFile(filename: string): FileBucket {
  const f = filename.toLowerCase();
  if (f.includes("light")) return { collection: "Theme", mode: "Light" };
  if (f.includes("dark")) return { collection: "Theme", mode: "Dark" };
  if (f.includes("typography")) return { collection: "Typography", mode: null };
  if (f.includes("dimension") || f.includes("spacing")) return { collection: "Dimension", mode: null };
  if (f.includes("color")) return { collection: "Color", mode: null };
  if (f.includes("global") || f.includes("component")) return { collection: "Global", mode: null };
  const base = filename.replace(/\.tokens\.json$/i, "");
  return { collection: base || "Tokens", mode: null };
}
