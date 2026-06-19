# figma-token-export

A Figma plugin that syncs **local variables** with the `*.tokens.json` files consumed by
[token-inspector](../token-inspector), without a Figma Enterprise plan. It reads variables via the
free Plugin API and reproduces Figma's REST variable-export JSON shape, then **commits them to a
GitHub or GitLab repo** (or downloads a `tokens.zip`), and can **import them back** into Figma.

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

Run the plugin. **Commit to repo** to push a versioned snapshot to **GitHub or GitLab**
(see below), **Import** to pull tokens back into Figma, or **Download .zip** for an offline
snapshot you drag into the inspector.

## Connect a repository (GitHub or GitLab)

Pick the **provider** (GitHub or GitLab) in the plugin, fill in the target and a Personal
Access Token, and click **Save settings** (stored in Figma `clientStorage`; the token stays
in the plugin's main thread and is never sent to the UI).

| Field | GitHub | GitLab |
|-------|--------|--------|
| **owner** | repo owner / org | group, e.g. `group` or `group/subgroup` |
| **repo** | repository name | project name |
| **branch** | target branch | target branch |
| **path** | folder for the token files (blank = repo root) | same |
| **host** | — | blank = `gitlab.com`, or your self-hosted base URL |
| **token (PAT)** | fine-grained PAT, **Contents: read and write** | PAT with the **`api`** scope (or `read_repository` + `write_repository`) |

## Commit to the repo

Click **Commit to GitHub / GitLab** — the six `*.tokens.json` files are written as **one
atomic commit**; the commit URL appears in the status line. A brand-new **empty** repository
is initialized automatically (no manual first commit needed).

**Download .zip** still works as an offline snapshot (filename `tokens-YYYYMMDD-HHMMSS.zip`).

## Import (repo → Figma)

Pull tokens back into the current Figma file:

1. **Preview from repo** — reads `*.tokens.json` from the configured provider / owner / repo /
   branch / path (the same token; read access is covered by the scopes above), or **Preview
   from file…** to pick a `tokens.zip` / individual `.json` files.
2. Review the diff (new / changed / unchanged counts + warnings).
3. **Apply to Figma** — existing variables are updated in place (matched by
   `com.figma.variableId`, then collection+name); missing ones are created; alias relationships
   are reconstructed. Nothing is deleted. Use **Cmd+Z** to undo.

**Round-trip tip:** variables are matched by id, so import back into the **same file** the
tokens were exported from — importing a backup into a different/diverged file recreates the
variables and breaks existing component bindings. Exports embed `com.figma.collectionName` /
`modeName` / `resolvedType` in each token's `$extensions` so collections, modes, and booleans
reconstruct losslessly; files exported by older versions still import via filename inference.

## Self-hosted GitLab

Figma only allows network requests to domains listed in the manifest. `api.github.com` and
`gitlab.com` are allowed out of the box. For a self-hosted GitLab, add your instance to
`package.json` → `figma-plugin.networkAccess.allowedDomains`
(e.g. `"https://gitlab.example.com"`), run `npm run build`, then re-import the manifest in Figma.

## Architecture

- `src/format.ts`, `src/mapping.ts`, `src/export.ts`, `src/parse.ts`, `src/diff.ts` — pure,
  unit-tested token core (export builder + import parser/planner).
- `src/settings.ts`, `src/git/` — pure helpers and the git providers: `provider.ts` (the
  provider-agnostic contract), `github.ts` (Git Data API), `gitlab.ts` (REST v4 Commits API),
  `select.ts` (provider routing). Injectable `fetch` → unit-tested.
- `src/main.ts` — reads the Figma variables API, stores settings/PAT in `clientStorage`, runs
  commit / import in the main thread (impure).
- `src/ui.tsx`, `src/ui/ImportPanel.tsx` — settings form (provider toggle + host), commit / zip
  buttons, import preview, status.

## Limitations (v1)

- Local variables only (no styles, no remote/library variables).
- **Import does not write variable scopes.** `applyPlan` sets variable values and aliases but never
  writes `com.figma.scopes`, so imported variables keep Figma's default scopes and any scope
  configuration in the source token set is not restored. (Confirmed by the round-trip fidelity test,
  which strips `com.figma.scopes` before comparing — see `src/roundtrip.test.ts`.)
- GitHub and GitLab sync via PAT; OAuth and other providers are not implemented.
- The collection→filename mapping in `src/mapping.ts` assumes collection names containing
  `color`/`dimension`/`typography`/`global` and `light`/`dark` modes. Adjust the constants there if
  your file uses different names.
- Collections that merge into `global.tokens.json` and whose variables are not self-prefixed
  (e.g. `components/sidebar`) lose their namespace and surface as ungrouped tokens in the
  inspector. Deferred — see [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).
