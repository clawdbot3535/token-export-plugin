# Design: import round-trip fidelity test + verification (Stage 3 close-out)

- **Date:** 2026-06-19
- **Status:** DRAFT (awaiting user review)
- **Branch:** `feat/import-roundtrip`
- **Parent design:** `~/.gstack/projects/clawdbot3535-token-inspector/christian-main-design-20260610-113605.md`
  (token-creator). This is **Stage 3** of that plan — the plugin import direction. The import was
  built under `docs/superpowers/specs/2026-06-11-figma-token-import-design.md` (+ the GitLab-support
  follow-up); this spec closes Stage 3 by adding its defining success criterion.

## Problem / goal

The import-into-Figma direction (`parse → buildPlan → applyPlan`, plus `collectData`) is functionally
complete and shipping. But the parent design defines the Stage 3 success criterion as a **round-trip
fidelity** check (parent, "Success Criteria" Stage 3):

> the set imported into Figma via the plugin, exported back out, and compared in **canonical DTCG
> form**: keys sorted, aliases preserved unresolved, modes matched by name, `$description` ignored.
> Comparison is restricted to the imported set; canonical forms of that set must be identical.

No such test exists. The import design (`2026-06-11-figma-token-import-design.md:55`) deliberately
left the impure modules (`applyPlan`, `collectData`) with **manual QA only, no unit tests** — a
reasonable posture at the time, but it means the end-to-end write+read path has never been exercised
in CI, and the Stage 3 criterion is unverified.

**Goal:** close Stage 3 by (1) independently verifying the import path is correct, and (2) adding the
round-trip fidelity test — which requires upgrading the testing posture for these specific impure
modules from "manual QA only" to "tested against an in-memory Figma fake".

Success criteria:
- A round-trip test drives the **real** pipeline — `buildExport → parse → buildPlan → applyPlan →
  collect → buildExport` — over an in-memory Figma fake, and asserts canonical-DTCG identity of the
  imported set across the cycle. Covers literals, aliases, ≥2 modes, and ≥2 collections.
- The same fake powers **explicit `applyPlan` semantic tests** that individually pin the three
  behaviours that currently have no direct test: upsert (re-import = no duplicates), alias topological
  ordering, and no-implicit-deletion.
- An independent code-review pass of the import path (`parse`/`diff`/`figma-write`/`collect`)
  confirms the "production-ready" assessment; CRITICAL/HIGH findings are fixed, others reported.
- `npx vitest run`, `npm run typecheck`, and `npm run build` all green. The plugin still builds
  (the `collectData` extraction must not change runtime behaviour).

## Decisions

- **Extract `collectData` → `src/collect.ts` (exported `collect()`); `main.ts` imports it.** The
  Figma→`CollectedData` mapping currently lives inside the plugin-entry file (`main.ts:19-45`), which
  imports `@create-figma-plugin/utilities` and is untestable in vitest. Moving it into a focused
  `collect.ts` (an impure edge, sibling to `figma-write.ts`) lets the round-trip use the **real**
  re-collect rather than a test-local reimplementation — which is the whole point of "re-collect →
  export". This is a targeted improvement that directly serves the test goal, not unrelated
  refactoring. `main.ts` keeps its behaviour; it just imports `collect` instead of defining it.
- **An in-memory Figma fake (`src/fake-figma.ts`, test-only).** A minimal, stateful object that
  implements exactly the `figma.variables.*` surface that `applyPlan` (write) and `collect` (read)
  touch — nothing more. Installed per-test via `vi.stubGlobal("figma", …)`. It is the first thing in
  the repo to drive the impure edges; existing tests only feed literals into the pure functions. It
  is **not** imported by `main.ts`, so `build-figma-plugin` never bundles it; `tsc --noEmit`
  typechecks it like any source file.
- **Canonical form normalises away what cannot survive a round-trip, asserts what must.** The
  exporter records Figma-assigned identity in `$extensions` (`com.figma.variableId`,
  `com.figma.scopes`) and resolves aliases to literals while recording the target in
  `com.figma.aliasData` (`export.ts:132-155`). On re-import the fake assigns **new** variable ids,
  and `applyPlan` does not set scopes — so those two fields legitimately differ. The canonicalizer
  therefore: sorts object keys; drops `com.figma.variableId` and `com.figma.scopes`; ignores
  `$description`; and **keeps** the token path, `$type`, `$value` literal, mode/collection names, and
  `com.figma.aliasData` (so an alias is compared by its target, "preserved unresolved", not by the
  resolved literal alone).
- **Deliberate posture change for two modules, scoped.** Upgrading `applyPlan`/`collect` from
  "manual QA only" to "fake-backed unit + round-trip tests" is a conscious revision of the
  `2026-06-11` import design's stance, justified by the Stage 3 criterion. It applies to these
  modules only; the other impure edges (git providers, UI) keep their existing posture.

## Design

### `src/collect.ts` (new — extracted impure edge)
- `export async function collect(): Promise<CollectedData>` — the exact body of today's
  `collectData` (`main.ts:19-45`), unchanged: walks `figma.variables.getLocalVariableCollectionsAsync()`,
  resolves each `variableIds` entry via `getVariableByIdAsync`, maps to `CollectedCollection` /
  `CollectedVariable` (`id, name, resolvedType, valuesByMode, scopes, collectionId`).
- `main.ts` deletes its local `collectData` and imports `{ collect } from "./collect"`; the four call
  sites (`main.ts:92,118,128,141,158`) call `collect()`. No behaviour change.

### `src/fake-figma.ts` (new — test-only in-memory Figma)
- `export function createFakeFigma(initial?: CollectedData): { figma: <PluginApi subset> }` (or a
  small class) holding mutable in-memory collections + variables. It supports precisely:
  - **Read (for `collect`)**: `variables.getLocalVariableCollectionsAsync()` → collection objects with
    `id`, `name`, `defaultModeId`, `modes:[{modeId,name}]`, `variableIds:string[]`;
    `variables.getVariableByIdAsync(id)` → variable with `id`, `name`, `resolvedType`,
    `valuesByMode`, `scopes`, `variableCollectionId`.
  - **Write (for `applyPlan`)**: `variables.createVariableCollection(name)` → object with mutable
    `modes` (seeded with one default mode), `renameMode(modeId,name)`, `addMode(name)`, `variableIds`;
    `variables.createVariable(name, col, type)` → registers a new variable into the id index **and**
    `col.variableIds` immediately (so `collect` sees it), returning an object with `id`, `name`,
    `resolvedType`, `valuesByMode`, `variableCollectionId`, `scopes` (default `[]`), and
    `setValueForMode(modeId, value)` that mutates `valuesByMode`; `variables.createVariableAlias(target)`
    → `{ type: "VARIABLE_ALIAS", id: target.id }`.
  - Ids are assigned by a monotonic counter (`VariableCollectionId:1`, `VariableID:1`, …) so re-import
    produces *new* ids — exactly the condition the canonicalizer must absorb.
- Seeded from a `CollectedData` fixture so tests can start from an empty file **or** a pre-populated
  one (the no-deletion / wrong-file / idempotency cases need a populated start).
- Documented as a deliberately minimal model with its assumptions listed (single default mode on
  collection creation; no validation of value/type coupling beyond what `applyPlan` itself does).

### `src/canonical.ts` (new — test-support, pure)
- `export function canonicalize(files: ExportFile[]): unknown` — parses each file's JSON, walks every
  token leaf, removes `com.figma.variableId` / `com.figma.scopes` / `$description`, and returns a
  representation with deterministically sorted keys (e.g. a recursively key-sorted object, or sorted
  `[path, $type, $value, aliasData]` tuples). Aliases compared via `com.figma.aliasData`.
- Pure and reusable across the round-trip and any future fidelity test.

## Tests

### `src/roundtrip.test.ts` (the Stage 3 criterion)
- **Fixture** `state0: CollectedData` exercising the full surface: 2 collections (one with 2 modes,
  e.g. Light/Dark), color + number + string + boolean literals, and at least one **alias** (a
  semantic var aliasing a primitive, including a cross-mode/cross-collection alias).
- **Cycle**: `files0 = buildExport(state0)` → `parse(files0.files)` → `buildPlan(parsed, EMPTY)` →
  `vi.stubGlobal("figma", fake.figma)`; `await applyPlan(plan)` → `state1 = await collect()` →
  `files1 = buildExport(state1)`.
- **Assert**: `canonicalize(files0.files)` deep-equals `canonicalize(files1.files)`; `applyPlan`
  summary has `errors: []`; export `warnings` empty for the round-tripped set.
- **Re-import idempotency (second lap)**: feed `files1` back through `buildPlan(parse(files1), collect())`
  against the now-populated fake → assert `creates.length === 0`, `updates.length === 0`,
  `unchangedCount === <all vars>`, and `ops` empty (proves upsert/no-duplication empirically).

### `src/figma-write.test.ts` (new — pin the impure write semantics)
- **Upsert**: applyPlan a create plan into an empty fake → N vars created; build a no-op plan from the
  same parsed model against the re-collected state → applyPlan reports 0 created, and the fake holds
  exactly N variables (no duplicates).
- **Alias topological order**: a plan whose `setAlias` target is created in the *same* plan → after
  applyPlan the alias var's `valuesByMode` holds a `VARIABLE_ALIAS` pointing at the target's id, with
  no errors (the `ops` ordering in `diff.ts:270` guarantees target-before-alias).
- **No implicit deletion**: seed the fake with an extra variable absent from the plan → after
  applyPlan that variable still exists unchanged (additive sync, `diff.ts:243-244`).
- **External/missing alias target reports, does not throw**: a `setAlias` whose target is neither in
  the plan nor in the fake → `summary.errors` contains a target-not-found message, other ops succeed
  (`figma-write.ts:86-88`).

### `src/collect.test.ts` (new — pin the extracted read edge)
- Seed the fake with a small `CollectedData`; `vi.stubGlobal` it; assert `await collect()` reproduces
  the same collections/variables/modes shape (id, name, resolvedType, valuesByMode, scopes,
  collectionId) — guards the extraction against drift.

## Verification
- `npm run typecheck && npx vitest run && npm run build` all green (build proves the `collect`
  extraction didn't break the plugin entry; the fake is not bundled).
- **Independent code review** (code-reviewer subagent) of `parse.ts`, `diff.ts`, `figma-write.ts`,
  `collect.ts` against the 5 import semantics; CRITICAL/HIGH fixed, findings reported in the PR/summary.
- Round-trip + idempotency assertions are the empirical proof of upsert / modes-by-name / alias
  ordering / no-deletion / fidelity.

## Out of scope
- **Live Figma QA** (loading the built plugin in the Figma app and importing a real Creator output) —
  valuable but user-driven and separate; the in-memory fake is what gives CI confidence without it.
- **`@tg/grammar` publish/consume.** The parent design names Stage 3 the publish trigger for the
  grammar package (plugin-side import validation). The current import is intentionally self-contained
  (runtime checks only); adding grammar-based validation is a later increment, not this one.
- **UI changes** to `ImportPanel.tsx`; **deletion / destructive sync** semantics (the design is
  additive by decision).
- Round-tripping `com.figma.variableId` / `com.figma.scopes` (normalised away by design — they are
  Figma-assigned and not part of the token contract).

## Risks
- **Fake drift from real Figma.** The fake could behave unlike the real Plugin API. Mitigation: keep
  it minimal, document its assumptions, and pin only behaviour `applyPlan`/`collect` actually rely on;
  the explicit semantic tests + round-trip describe observable contracts, not Figma internals. Live
  QA (out of scope here) remains the final word on real-API conformance.
- **`collect` extraction touches the plugin entry (`main.ts`).** Low risk — a pure move + import.
  Mitigation: `npm run build` (`build-figma-plugin --typecheck`) must stay green; behaviour is
  byte-for-byte the same function.
- **Canonical-form over-normalisation** could hide a real regression (e.g. stripping a field that
  *should* round-trip). Mitigation: strip only the two Figma-identity fields with documented
  rationale; keep `aliasData`, `$type`, `$value`, names — the fields the token contract guarantees.
