# Figma token import — design

Status: approved (brainstorming) · 2026-06-11

## Goal

Extend the plugin so design tokens can flow **back** from a repo into Figma local
variables, not just out. This reverses the existing one-way export
(Figma → `*.tokens.json` → repo). The README currently lists this as an explicit
v1 limitation ("pulling tokens back into Figma are not implemented").

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Import semantics | **Upsert / full sync** — update existing variables, create missing ones |
| Deletions | **Never delete** — additive only; Figma-only variables stay untouched |
| Aliases | **Reconstruct** real Figma alias bindings from `com.figma.aliasData` |
| Source | **Both** — pull from GitHub repo *and* local upload (zip / `.json` files) |
| Safety | **Diff preview, then Apply** — show added/changed/unchanged, write on confirm |
| Strategy | **Approach C** — variableId-anchored upsert + a small, backward-compatible export extension so files self-describe their collection/mode |

## Why Approach C

`com.figma.variableId` is a reliable anchor for **updates** (exact match when the
file was exported from the same Figma file). But the export format is lossy for
**new** variables: a token's originating collection is not stored per-variable
(only the filename as a coarse bucket, and `aliasData.targetVariableSetName` only
for the alias *target*).

Approach C adds three keys to each leaf's `$extensions` on export —
`com.figma.collectionName`, `com.figma.modeName`, `com.figma.resolvedType` —
mirroring the existing `aliasData.targetVariableSetName` pattern. Files then
self-describe their collection and mode, so new variables and modes reconstruct
losslessly. `resolvedType` also resolves the BOOLEAN ambiguity (booleans export as
`"true"`/`"false"` strings under `$type: "string"`).

Backward compatible: when these keys are absent (files exported by the old
version), import falls back to filename-based inference (`import-mapping.ts`).

## Architecture

Mirrors the existing pure-core / impure-shell split. All decision logic lives in
pure, unit-tested modules; the Figma and network layers stay thin.

### Pure modules (vitest)

| Module | Role | Reverse of |
|---|---|---|
| `src/format.ts` *(extend)* | `parseColor` (`{components, alpha, hex}` → `{r,g,b,a}`), `parseLiteral` (number/string/bool/color → `CollectedValue`) | `formatLiteral` / `formatColor` |
| `src/import-mapping.ts` *(new)* | `collectionModeForFile(filename)` — fallback collection/mode inference when extensions are absent | `mapping.ts` |
| `src/parse.ts` *(new)* | `parse(files) → ParsedModel` — walk JSON trees, collect leaves, merge the same variable across `light`/`dark` files by id/name | `buildExport` |
| `src/diff.ts` *(new)* | `buildPlan(parsed, current) → ImportPlan` — preview summary **and** a pre-ordered declarative op list | — |

### Impure modules (no unit tests; manual QA — same posture as `collectData`)

| Module | Role |
|---|---|
| `src/git/provider.ts` *(extend)* | add `readFiles` to the interface + request/result types |
| `src/git/github.ts` *(extend)* | `readFiles` via the Contents API. Use `Accept: application/vnd.github.raw` on file GETs → raw text, so no base64 decoder is needed in the main thread (`atob` is not guaranteed there) |
| `src/figma-write.ts` *(new)* | `applyPlan(plan) → ApplySummary` — interprets `plan.ops` against `figma.variables.*`; no decision logic |
| `src/main.ts` *(extend)* | message handlers `IMPORT_GITHUB`, `IMPORT_LOCAL`, `IMPORT_APPLY` |
| `src/ui/ImportPanel.tsx` *(new)* | import section + diff preview. Existing export controls in `ui.tsx` stay untouched (surgical change) |

### Pre-ordered op list

`diff.ts` emits a declarative, pre-sorted `ops` array so the write layer is a dumb
interpreter and the two-pass ordering (literals before aliases) lives in tested code:

```
createCollection → addMode → createVariable → setLiteral → setAlias
```

Op kinds (sketch):

```ts
type ApplyOp =
  | { kind: "createCollection"; name: string }
  | { kind: "addMode"; collection: string; mode: string }
  | { kind: "createVariable"; collection: string; name: string; type: FigmaResolvedType }
  | { kind: "setLiteral"; collection: string; name: string; mode: string; value: CollectedValue }
  | { kind: "setAlias"; collection: string; name: string; mode: string; targetCollection: string; targetName: string };
```

`figma-write.ts` keeps name→variable and name→collection maps as it creates them,
and resolves `setAlias` target refs to variable ids at apply time.

## Matching strategy (upsert without duplicates)

Per parsed variable, in priority order:

1. `com.figma.variableId` matches a current variable → exact **update**.
2. Fallback `(collectionName + variableName)` matches → same logical variable,
   different id (e.g. imported into another file) → **update**, not duplicate.
3. No match → **create**.

## Data flow

```
GitHub:  UI "Preview from GitHub" → IMPORT_GITHUB → main: readFiles → parse → diff(parsed, collectData())
         → IMPORT_PLAN(summary) → UI diff preview → "Apply" → IMPORT_APPLY
         → main: re-parse + re-diff (against possibly-changed Figma state) → applyPlan → IMPORT_DONE(summary)
Local:   UI file input → fflate unzipSync / .json → ImportFile[] → IMPORT_LOCAL → (identical from parse onward)
```

On Apply the plan is **recomputed** (not the preview plan blindly executed), so it
stays correct if the Figma file changed between preview and apply.

## Export change (Approach C)

In `buildExport` (`src/export.ts`), add to each leaf's `$extensions`:

```ts
"com.figma.collectionName": col.name,
"com.figma.modeName": mode.name,
"com.figma.resolvedType": v.resolvedType,
```

Update `export.test.ts` expectations accordingly.

## Error handling

- **GitHub read:** reuse `CommitError` kinds (`auth` / `not-found` / `network` /
  `unexpected`) + new `no-tokens` (folder contains no `*.tokens.json`). PAT needs
  only **Contents: read** (covered by the existing `write` scope).
- **parse / diff:** collect warnings instead of throwing — malformed leaf, unknown
  `$type`, type conflict (Figma COLOR ↔ file number → skip + warn), unresolvable
  alias target (skip that mode binding + warn). Aliases are reconstructed; if a
  target genuinely cannot be found, warn (no silent literal fallback, per the
  "reconstruct" decision).
- **applyPlan:** try/catch per op, errors surfaced in the summary, never a partial
  crash. Document the Cmd+Z undo caveat.

## Testing

New / extended pure-module tests:

- `format.test.ts` — round-trip `parse ∘ format = identity` for color/number/string.
- `parse.test.ts` — files → `ParsedModel`; merge across `light`/`dark`; extensions
  vs filename fallback; alias parsing.
- `import-mapping.test.ts` — filename → bucket/mode.
- `diff.test.ts` — create vs update classification; changed/unchanged; op ordering
  (literals before aliases); name-fallback matching; type-mismatch warning.
- `github.test.ts` — `readFiles` with injected fetch (dir listing + raw file GET +
  error mapping).
- `export.test.ts` — updated for the new extension keys.

`figma-write.ts` and `main.ts` stay impure → manual QA in Figma.

## Scope boundaries (YAGNI)

- No deletion (additive sync only).
- No GitLab / other providers.
- No styles, no remote/library variables (same as export v1).
- No conflict-resolution UI beyond diff preview + Apply / Cancel.
- Boolean fidelity via `resolvedType`; legacy files without it → booleans import as
  strings (documented limitation).

## Docs to update on completion

- `README.md` — remove the "pulling tokens back into Figma" limitation; document
  the Import flow and the new export extension keys.
- `docs/KNOWN-ISSUES.md` — note the legacy-file boolean/collection fallback.
