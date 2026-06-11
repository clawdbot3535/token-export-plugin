# Known Issues

## 1. `components/sidebar` tokens lose their collection namespace (deferred)

**Status:** Known, deferred (2026-05-26). Left as-is for now — the Figma theme is
still work-in-progress and some of these tokens are not Nuxt-relevant.

### Symptom

After importing the exported `tokens.zip` into `token-inspector`, ~16 tokens appear at
the **root** of `global.tokens.json` with no component group, so they show up *outside*
the component navigation in the inspector's left sidebar, each flagged
**"No Tailwind utility mapping"**:

```
width, width-collapsed, bg, border, padding-x, padding-y,
item-radius, item-padding-x, item-padding-y, item-bg-hover, item-bg-active,
item-text, item-text-active, item-icon-size, section-label-size, section-label-color
```

(plus a lone root token `border`, a Figma variable literally named `border` that aliases
`color/border/default` — same mechanism.)

### Root cause

The plugin routes multiple Figma collections into the inspector's six fixed files. Three
collections land in the single **component-layer** file `global.tokens.json`:

| Collection | Variable naming | Result in `global.tokens.json` |
|---|---|---|
| `components/global` | self-prefixed (`button/…`, `input/…`) | groups correctly under button/input/… |
| `layout/global` | self-prefixed (`page/…`, `grid/…`) | groups correctly under page/grid/… |
| `components/sidebar` | **not** prefixed (`width-collapsed`, `item-*`) | **collapses to root-level orphans** |

The merge keys tokens only by the Figma **variable name**. In Figma, a variable's
namespace is its **collection** (orthogonal to the name). `components/sidebar`'s variables
rely on the collection as their namespace, so merging them by bare name into a file shared
with `components/global` drops that namespace.

### Not a data-loss bug

All 16 sidebar tokens are present and correct — `global.tokens.json` has 450 leaves =
410 (`components/global`) + 16 (`components/sidebar`) + 24 (`layout/global`), **0 path
collisions**. Token *count* differences vs. the older per-collection `.zip` exports are
stale-snapshot drift (those zips predate current Figma edits), not loss. The issue is
purely **grouping/namespace**, and the resulting "No Tailwind utility mapping" warnings are
the inspector correctly flagging custom/WIP component tokens outside its Nuxt slot
vocabulary — expected, not a defect.

### Fix options (when revisited)

**Z — minimal, plugin-only (inspector unchanged).** When more than one collection routes
to the same output file, prefix each token with the collection's **last path segment**,
except when that segment is `global` (the flat catch-all):

- `components/global` → flat → `button/…` (Nuxt mappings stay intact)
- `layout/global` → flat → `page/…`
- `components/sidebar` → `sidebar/` → `sidebar/width-collapsed` ✓ groups under `sidebar`

~20 LOC in `src/export.ts` + a test. Single-collection files (color/dimension/typography/
light/dark) are unaffected (no double-prefix). Grouping stays variable-name-based, not
strictly collection-based.

**A — faithful, cross-repo.** Emit one file per Figma collection (mirroring the original
per-collection REST exports) and extend the inspector's ingest (`src/app/load-sources.ts`,
the `SourceLayer` type, and `build-graph.ts` `layerFor`) to derive layer/theme from the
**collection name** instead of six fixed filenames. The inspector nav then groups strictly
by Figma collection (`primitives/color`, `components/sidebar`, `layout/global`, …). Closest
to "paths identical to Figma," but a moderate refactor in both repos and retires the
six-file model.

Layer derivation for option A: `primitives/*` → primitive · `semantic` → semantic
(light/dark modes) · `components/*` + `layout/*` → component.

## Import: legacy files without self-describing extensions

Token files exported before the import feature lack
`com.figma.collectionName` / `modeName` / `resolvedType`. On import these fall back
to filename-based collection/mode inference (e.g. `light.tokens.json` → a `Theme`
collection's `Light` mode), and BOOLEAN variables reconstruct as strings. Re-export
once with the current version to make future round-trips lossless.
