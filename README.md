# figma-token-export

A Figma plugin that exports **local variables** to the `*.tokens.json` files consumed by
[token-inspector](../token-inspector), without a Figma Enterprise plan. It reads variables via the
free Plugin API and reproduces Figma's REST variable-export JSON shape, then downloads a `tokens.zip`
you drop into the inspector.

## Why

The Figma Variables **REST** API (and its personal access token) requires Enterprise. The **Plugin**
API reads local variables on any plan — so this plugin produces the same JSON locally and for free.

## Develop

Requires Node v22+.

```bash
npm install
npm run build      # generates manifest.json + build/
npm test           # vitest unit tests for the pure core
npm run watch      # rebuild on change
```

In the Figma desktop app: Quick Actions → `Import plugin from manifest…` → select `manifest.json`.

## Use

Run the plugin. Either **Commit to GitHub** (versioned, see below) or **Download .zip** for an
offline snapshot you drag into the inspector.

## Commit to GitHub

1. Create a **fine-grained Personal Access Token** scoped to your tokens repo with
   **Contents: read and write**.
2. In the plugin, fill in **owner / repo / branch / path**, paste the **PAT**, and click
   **Save settings** (stored in Figma `clientStorage`; the token stays in the plugin's main
   thread and is never sent to the UI).
3. Click **Commit to GitHub** — the six `*.tokens.json` files are written as one atomic commit;
   the commit URL appears in the status line. A brand-new **empty** repository is initialized
   automatically (orphan first commit) — no manual first commit needed.

**Download .zip** still works as an offline snapshot (filename `tokens-YYYYMMDD-HHMMSS.zip`).

## Import (repo → Figma)

Pull tokens back into the current Figma file:

1. **Preview from GitHub** — reads `*.tokens.json` from the configured
   owner/repo/branch/path (PAT needs **Contents: read**, covered by the write
   scope), or **Preview from file…** to pick a `tokens.zip` / `.json` files.
2. Review the diff (new / changed / unchanged counts + warnings).
3. **Apply to Figma** — existing variables are updated in place (matched by
   `com.figma.variableId`, then collection+name); missing ones are created;
   alias relationships are reconstructed. Nothing is deleted. Use **Cmd+Z** to undo.

Exports now embed `com.figma.collectionName` / `modeName` / `resolvedType` in each
token's `$extensions` so a round-trip reconstructs collections, modes, and booleans
losslessly. Files exported by older versions still import via filename inference.

## Architecture

- `src/format.ts`, `src/mapping.ts`, `src/export.ts` — pure, unit-tested token core.
- `src/timestamp.ts`, `src/settings.ts`, `src/git/` (`provider.ts` + `github.ts`) — pure helpers and
  the GitHub commit provider (Git Data API, injectable `fetch` → unit-tested).
- `src/main.ts` — reads the Figma variables API, stores settings/PAT in `clientStorage`, runs the
  commit in the main thread (impure).
- `src/ui.tsx` — settings form, commit / zip buttons, status.

## Limitations (v1)

- Local variables only (no styles, no remote/library variables).
- GitHub sync via PAT; OAuth and GitLab/other providers are not implemented.
- The collection→filename mapping in `src/mapping.ts` assumes collection names containing
  `color`/`dimension`/`typography`/`global` and `light`/`dark` modes. Adjust the constants there if
  your file uses different names.
- Collections that merge into `global.tokens.json` and whose variables are not self-prefixed
  (e.g. `components/sidebar`) lose their namespace and surface as ungrouped tokens in the
  inspector. Deferred — see [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).
