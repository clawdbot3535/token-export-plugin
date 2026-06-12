# GitLab support — design

Status: approved (brainstorming) · 2026-06-12

## Goal

Add GitLab as a second git provider alongside GitHub, with full parity: commit
exported tokens **and** read them back for import. Today the plugin is GitHub-only
(`src/git/github.ts`); the `GitProvider` interface in `src/git/provider.ts` was
designed to be provider-agnostic for exactly this.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Instances | **gitlab.com + self-hosted** — configurable host |
| Settings model | **Reuse `owner`/`repo`** + add `provider` switch + `host` field. No migration of existing GitHub settings |
| Scope | **Full parity** — commit (export) + readFiles (import), incl. empty-repo |
| Wiring | Host is **provider construction config**; a `selectProvider(settings)` picks the provider. `GitProvider` contract unchanged |
| Auth | PAT only (no OAuth), header `PRIVATE-TOKEN` |
| Project id | Path only (`owner/repo` → `group/project`), no numeric project id |

## Why this wiring

Because `owner`/`repo` are reused and the host is passed at construction, the
`GitProvider` contract (`commit` / `readFiles` with `owner/repo/branch/path/token`)
stays **unchanged**. The entire import core (`parse.ts`, `diff.ts`,
`figma-write.ts`) and the export path are untouched. GitLab is purely additive: a
new provider implementation, a selector, and settings/UI fields.

*Rejected:* putting `host` in every `CommitRequest`/`ReadRequest` — pollutes every
request with provider-specific config. Host belongs on the provider instance.

## Architecture

### New / changed modules

| Module | Status | Responsibility |
|---|---|---|
| `src/git/gitlab.ts` | new | `createGitLabProvider(host, fetchFn)` implementing `GitProvider` against GitLab REST v4. Injectable `fetch` → unit-tested like `github.ts` |
| `src/git/select.ts` | new | `selectProvider(settings, fetchFn?): GitProvider` — returns the GitHub or GitLab provider based on `settings.provider` |
| `src/settings.ts` | modify | add `provider: "github" \| "gitlab"` and `host: string`; extend `validateSettings`; add `withDefaults` for migration |
| `src/main.ts` | modify | use `selectProvider(settings)` in the COMMIT and IMPORT handlers instead of `createGitHubProvider()`; default stored settings via `withDefaults` on load |
| `src/ui.tsx` | modify | provider selector (Dropdown) + host textbox shown only when GitLab is selected |
| `package.json` | modify | add `https://gitlab.com` to `figma-plugin.networkAccess.allowedDomains` |

### GitProvider contract

Unchanged. The GitLab provider receives `owner`/`repo` in each request and builds
the URL-encoded project path internally (`encodeURIComponent(`${owner}/${repo}`)`),
e.g. `group/sub/project` → `group%2Fsub%2Fproject`. `owner` may itself contain a
group path (`group/sub`), so nested groups work.

## GitLab REST v4 mapping

Base: `${host}/api/v4` (host defaults to `https://gitlab.com`). Auth header
`PRIVATE-TOKEN: <PAT>` on every request. `Content-Type: application/json` for
writes.

### Commit (atomic, multiple files)

`POST ${base}/projects/:path/repository/commits`

```json
{
  "branch": "<branch>",
  "commit_message": "<message>",
  "actions": [
    { "action": "create" | "update", "file_path": "tokens/color.tokens.json", "content": "<utf-8>" }
  ]
}
```

GitLab has no upsert action, so the per-file action must be `create` (new file) or
`update` (existing). Determine which by listing the existing tree once before
committing. The folder to list is derived from the shared prefix of the request's
file paths (`req.files[].path`, e.g. `tokens/color.tokens.json` → folder `tokens`;
a root-level file → folder `""`):

1. `GET ${base}/projects/:path/repository/tree?path=<derived folder>&ref=<branch>&per_page=100`
   - On `404` (empty repo / branch absent) → treat all files as new (`create`),
     and the commit creates the branch (GitLab creates the target branch when it
     does not exist and no `start_branch` is given). No GitHub-style bootstrap.
   - Otherwise → build a set of existing blob `path`s; per file, action `update`
     when its full `path` is in the set, else `create`.

Response: return `{ sha: body.id, commitUrl: body.web_url }`.

### Read (import)

1. List: `GET ${base}/projects/:path/repository/tree?path=<folder>&ref=<branch>&per_page=100`
   → array of `{ name, type, path }`; keep `type === "blob" && name.endsWith(".tokens.json")`.
   Empty / no matches → `CommitError("no-tokens", …)`.
2. Raw content per file: `GET ${base}/projects/:path/repository/files/<url-encoded full path>/raw?ref=<branch>`
   → raw text. Build `{ filename: name, content }[]`.

(`per_page=100` is sufficient for the six token files; pagination is out of scope.)

### Error mapping

`401`/`403` → `auth`; `404` → `not-found`; thrown fetch → `network`; empty token
folder → `no-tokens`; else → `unexpected`. Reuses the existing `CommitError` /
`CommitErrorKind` from `provider.ts` (no new kinds).

## Settings

```ts
interface Settings {
  provider: "github" | "gitlab";
  owner: string;
  repo: string;
  branch: string;
  path: string;
  host: string; // GitLab base host, e.g. "https://gitlab.example.com"; "" → gitlab.com
}
```

- `validateSettings`: `owner`/`repo`/`branch` still required (unchanged). `provider`
  must be one of the two. `host` optional; when provided for GitLab it must look
  like a URL (`https?://…`). GitHub ignores `host`.
- `withDefaults(stored)`: fills `provider: "github"` and `host: ""` when missing,
  so existing GitHub users' stored settings keep working with no migration.
- `host` is normalized (trailing slash stripped) where used; the token field and
  `clientStorage` token handling are unchanged.

## Self-hosted & networkAccess

Figma only allows statically-listed domains in `manifest.json`
(`networkAccess.allowedDomains`). We ship
`["https://api.github.com", "https://gitlab.com"]`. **Self-hosted GitLab users must
add their instance domain to `package.json` → `figma-plugin.networkAccess.allowedDomains`
and rebuild** (`npm run build`). This is documented in the README and surfaced as a
hint near the host field in the UI. (A wildcard `"*"` was rejected as too broad.)

## UI

- A provider selector (`@create-figma-plugin/ui` `Dropdown` or `SegmentedControl`):
  GitHub / GitLab, bound to `settings.provider`.
- A `host` `Textbox` shown only when GitLab is selected, placeholder
  `https://gitlab.com (or your instance)`, with the self-hosted manifest hint.
- Existing owner/repo/branch/path/token controls unchanged. Field labels stay
  `owner`/`repo` (for GitLab they mean group-path / project). Commit / Import /
  preview controls unchanged — they act on the selected provider.

## Testing

- `src/git/gitlab.test.ts` — mirrors `github.test.ts` with an injected fetch:
  - commit into a repo with existing files → `update` actions, correct
    `actions`/`branch`/`commit_message`, returns `web_url`;
  - commit into an empty repo (tree `404`) → all `create` actions, branch created;
  - `readFiles` → tree listing + raw fetch, filters non-token files, raw `ref`;
  - error mapping: `401`→auth, `404`→not-found, thrown→network, empty→no-tokens.
- `src/settings.test.ts` — extend for `provider`/`host` validation and
  `withDefaults` (missing fields default to github/"").
- `src/git/select.test.ts` — `selectProvider` returns the GitLab provider for
  `provider: "gitlab"` (with host) and GitHub otherwise.
- `src/main.ts` / `src/ui.tsx` stay impure → manual QA in GitLab (commit + import,
  gitlab.com and, if available, a self-hosted instance).

## Scope boundaries (YAGNI)

- PAT only (no OAuth).
- Path-based project id only (no numeric GitLab project id).
- No tree pagination (`per_page=100` covers the six token files).
- No automatic host discovery; self-hosted domain is a manual manifest entry.
- No third provider; the `IMPORT_GITHUB` message name stays (internal; not renamed).

## Docs to update on completion

- `README.md` — document provider selection, GitLab PAT scope (`api`, or
  `read_repository`/`write_repository`), and the self-hosted networkAccess/rebuild
  step.
