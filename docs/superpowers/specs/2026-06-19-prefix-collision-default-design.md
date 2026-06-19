# Design: leaf-vs-group name-collision fix (reserved `DEFAULT` key)

- **Date:** 2026-06-19
- **Status:** DRAFT (awaiting user review)
- **Branch:** `feat/prefix-collision-default`
- **Origin:** /investigate (in token-inspector) of `unresolved alias: color/white/alpha/…` errors.
  Confirmed root cause: a flat local variable whose **name is a path-prefix** of other variables
  (`color/white` is a prefix of `color/white/alpha/*`, both in collection `primitives/color`) gets
  **clobbered** in the DTCG export. `buildExport`'s `setNested` cannot represent a node that is both a
  token (`$value`) and a group (children); writing the bare `color/white` leaf replaces the
  `color/white` subtree, dropping the `alpha/*` children. The inspector then holds aliases
  (`color/surface/overlay-dark-border` → `color/white/alpha/500-8`) whose targets are absent → it
  correctly flags them unresolved. `color/red|amber|green` are unaffected (no bare `color/red` var —
  group-only — so no prefix collision).

## Problem / goal

Variables whose name is a path-prefix of other variables lose data on export (the bare leaf and the
deeper group cannot coexist at the same DTCG path). Fix the exporter so **both survive**, the export is
**valid DTCG**, and a **round-trip restores the exact Figma names**.

Success criteria:
- On the live export, `color/white/alpha/*` and `color/black/alpha/*` appear in `color.tokens.json`
  (no longer clobbered), so the inspector resolves their aliases and the v0.47.0 `unresolved-alias`
  groups for those families disappear.
- The export is valid DTCG: no node carries both `$value` and child groups. The colliding leaf is
  emitted at `<name>/DEFAULT`.
- Aliases pointing at a collapsed bare leaf still resolve (their `aliasData` target is rewritten to
  `<name>/DEFAULT`).
- Round-trip fidelity holds: a set exported (with the `DEFAULT` collapse) then imported restores the
  ORIGINAL Figma variable names (`color/white`, not `color/white/DEFAULT`) and the original alias
  targets. Verified by an extended `roundtrip.test.ts`.
- Inspector repo is UNCHANGED. Full suite + typecheck + build green.

## Decisions

- **Collapse the colliding leaf under a reserved `DEFAULT` child key** (DTCG-valid; the convention
  used by Tailwind / Style Dictionary). `color/white` → group `{ DEFAULT: <colour>, alpha: {…} }`.
  Only leaves that are a strict path-prefix of another exported variable are collapsed; non-colliding
  leaves are untouched.
- **Mark the collapse with an extension, don't infer it.** The collapsed `DEFAULT` leaf carries
  `$extensions["com.figma.collapsedDefault"] = true`. This makes the transform reversible without
  ambiguity — import can tell a *collapsed* leaf from a variable a designer genuinely named
  `something/DEFAULT`. The exporter already speaks in `com.figma.*` extensions; this is one more
  transport marker, not a change to the design's names.
- **Rewrite alias targets to collapsed leaves.** When an alias's `aliasData.targetVariableName` equals
  a collapsed leaf name, append `/DEFAULT`, so aliases at the bare colour resolve to the moved node.
- **Symmetric un-rename on import.** Because Stage 3 (round-trip) is shipped, import reverses the
  collapse: a marked `<name>/DEFAULT` leaf restores the Figma variable name `<name>`, and alias targets
  `<name>/DEFAULT` map back to `<name>` for collapsed names. Net: the round-trip is name-faithful.
- **Detect collisions globally over collected names.** A name `N` is collapsed iff some other collected
  variable name starts with `N + "/"`. Computing it once over all collected variables (not per-file) is
  simpler and safe (a prefix leaf is collapsed wherever it appears).

## Design

### Export — `src/export.ts`
1. **`findCollapsedLeaves(data: CollectedData): Set<string>`** (new, pure): the set of variable names
   `N` such that some other variable name starts with `N + "/"`. (`color/white`, `color/black` for the
   live data.)
2. In `buildExport`, compute `collapsed = findCollapsedLeaves(data)` once. When writing a variable
   whose `v.name ∈ collapsed`:
   - nest at path `[...v.name.split("/"), "DEFAULT"]` instead of `v.name.split("/")`;
   - add `"com.figma.collapsedDefault": true` to that leaf's `$extensions`.
3. When building `aliasData`, if the resolved target's name `∈ collapsed`, set
   `targetVariableName = target.name + "/DEFAULT"` (else unchanged). `targetVariableSetName` unchanged.

### Import — `src/parse.ts`
1. **Pre-pass:** walk all files to collect `collapsedNames: Set<string>` — for every leaf carrying
   `com.figma.collapsedDefault`, the bare name is its path minus the trailing `DEFAULT` segment
   (`color/white/DEFAULT` → `color/white`). (Pre-pass so alias/leaf order across files doesn't matter.)
2. **Main pass:** when a leaf carries `com.figma.collapsedDefault`, use the bare name (strip the
   trailing `/DEFAULT`) as the `ParsedVariable.name`. For alias values, if the parsed
   `targetName` is `<bare>/DEFAULT` and `<bare> ∈ collapsedNames`, rewrite `targetName` to `<bare>`.
3. Result: `applyPlan` creates/updates the Figma variable `color/white` (not `color/white/DEFAULT`) and
   binds aliases to it — the original structure.

### Why the inspector needs no change
The inspector walks the export tree and indexes leaves. After the fix, `color/white/alpha/500-8` is a
real leaf (group not clobbered) → indexed → the `color/surface/overlay-dark-border` alias resolves.
`color/white/DEFAULT` is just another primitive leaf (`color-white-default`); aliases to the bare colour
were rewritten to it, so they resolve too. The v0.47.0 `unresolved-alias` diagnostic still exists but no
longer fires for these families.

## Tests
- `src/export.test.ts`:
  - A `CollectedData` fixture with a bare leaf `color/white` + group `color/white/alpha/500-8` (+ a
    non-colliding `color/red/500`). Assert: `color/white` emits as `{ DEFAULT: {…, $extensions has
    com.figma.collapsedDefault}, alpha: { "500-8": {…} } }`; `color/red/500` stays a plain leaf
    (untouched); no node has both `$value` and a child group.
  - An alias whose target is `color/white` → exported `aliasData.targetVariableName === "color/white/DEFAULT"`.
- `src/parse.test.ts`:
  - Parsing a tree with a `com.figma.collapsedDefault` leaf at `color/white/DEFAULT` yields a
    `ParsedVariable` named `color/white`; an alias targeting `color/white/DEFAULT` parses with
    `targetName === "color/white"`.
- `src/roundtrip.test.ts` (extend): add a prefix-collision fixture (`color/white` + `color/white/alpha/500-8`
  + an alias to each) to the existing `STATE0`-style cycle. Assert the re-collected Figma state has a
  variable named `color/white` (NOT `color/white/DEFAULT`) and `color/white/alpha/500-8`, and the
  canonical export is identical across the cycle.
- A `tsx` probe over the real export (`token-inspector/assets/tokens-20260619-093216.zip` unzipped)
  confirming `color/white/alpha/*` is present after re-export (manual verification step).

## Out of scope
- **Inspector changes** — none; it resolves the now-present targets with existing code.
- **Reverting v0.47.0** — the grouped diagnostic stays; it just won't fire for these families once they
  resolve. (Its "library/remote" hint wording is inaccurate for prefix-collision cases — a separate,
  optional follow-up to reword; NOT in this increment.)
- **Library/remote variable export** — unrelated; these targets are local.
- **Non-`DEFAULT` collision conventions / configurability** — one reserved key, hardcoded.

## Risks
- **A real variable named `x/DEFAULT`** would be ambiguous on import — mitigated by the explicit
  `com.figma.collapsedDefault` marker (only marked nodes are un-renamed; genuine `x/DEFAULT` vars carry
  no marker and pass through).
- **Multi-level prefix chains** (e.g. `a` prefix of `a/b` which is prefix of `a/b/c`): `a` and `a/b`
  both get collapsed to `a/DEFAULT` and `a/b/DEFAULT`. `findCollapsedLeaves` handles this (each is a
  prefix of a deeper name); the nesting and un-rename compose. Covered by a fixture if it occurs.
- **Round-trip test coupling:** the canonical comparison already strips `com.figma.variableId`/`scopes`;
  it must NOT strip `com.figma.collapsedDefault` (that field is part of the asserted structure on the
  export side, and absent after import un-rename). The round-trip fixture asserts the IMPORTED Figma
  names, sidestepping any canonical-marker question.
