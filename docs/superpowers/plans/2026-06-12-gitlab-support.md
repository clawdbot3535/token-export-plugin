# GitLab Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitLab as a second git provider (commit + import, gitlab.com and self-hosted) alongside GitHub, selectable in settings, without changing the token core.

**Architecture:** The `GitProvider` contract (`commit`/`readFiles` with `owner/repo/branch/path/token`) stays unchanged. A new `createGitLabProvider(host, fetchFn)` implements it against GitLab REST v4 (injectable `fetch`, unit-tested like `github.ts`); a pure `selectProvider(settings)` picks GitHub vs GitLab; `Settings` gains `provider` + `host`. The import core (`parse.ts`/`diff.ts`/`figma-write.ts`) is untouched.

**Tech Stack:** TypeScript, Preact (`@create-figma-plugin/ui`), vitest, GitLab REST v4, GitHub REST.

**Spec:** `docs/superpowers/specs/2026-06-12-gitlab-support-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/settings.ts` | modify | add `provider`/`host` to `Settings`, `normalizeHost`, `withDefaults`, extend `validateSettings` |
| `src/settings.test.ts` | modify | fixtures + tests for provider/host/withDefaults |
| `src/git/gitlab.ts` | create | `createGitLabProvider(host, fetchFn)` — GitLab REST v4 provider |
| `src/git/gitlab.test.ts` | create | injected-fetch tests (commit create/update + empty, readFiles, errors) |
| `src/git/select.ts` | create | `selectProvider(settings, fetchFn?)` → `GitProvider` |
| `src/git/select.test.ts` | create | routing-by-URL-host tests |
| `src/main.ts` | modify | use `selectProvider` in COMMIT + IMPORT handlers; `withDefaults` on read |
| `src/ui.tsx` | modify | provider toggle + conditional host field |
| `package.json` | modify | add `https://gitlab.com` to `networkAccess.allowedDomains` |
| `README.md` | modify | document provider selection, GitLab PAT scope, self-hosted manifest step |

Test command: `npx vitest run <file>` for one file, `npm test` for all.

---

## Task 1: Settings — provider, host, withDefaults, validation

**Files:**
- Modify: `src/settings.ts`
- Test: `src/settings.test.ts`

- [ ] **Step 1: Replace the test file**

Replace the entire contents of `src/settings.test.ts` with:

```ts
// src/settings.test.ts
import { describe, expect, it } from "vitest";
import { normalizeHost, normalizePath, validateSettings, withDefaults, type Settings } from "./settings";

const gh: Settings = { provider: "github", owner: "me", repo: "tokens", branch: "main", path: "tokens", host: "" };
const gl: Settings = { provider: "gitlab", owner: "group/sub", repo: "tokens", branch: "main", path: "tokens", host: "https://gitlab.example.com" };

describe("validateSettings", () => {
  it("accepts valid github settings", () => {
    expect(validateSettings(gh)).toEqual([]);
  });
  it("accepts valid gitlab settings (with host)", () => {
    expect(validateSettings(gl)).toEqual([]);
  });
  it("accepts gitlab settings with an empty host (defaults to gitlab.com)", () => {
    expect(validateSettings({ ...gl, host: "" })).toEqual([]);
  });
  it("rejects empty owner/repo/branch with field-named errors", () => {
    const errs = validateSettings({ ...gh, owner: " ", repo: "", branch: "" });
    expect(errs.some((e) => /owner/i.test(e))).toBe(true);
    expect(errs.some((e) => /repo/i.test(e))).toBe(true);
    expect(errs.some((e) => /branch/i.test(e))).toBe(true);
  });
  it("rejects a gitlab host without an http(s) scheme", () => {
    const errs = validateSettings({ ...gl, host: "gitlab.example.com" });
    expect(errs.some((e) => /host/i.test(e))).toBe(true);
  });
  it("allows an empty path (repo root)", () => {
    expect(validateSettings({ ...gh, path: "" })).toEqual([]);
  });
});

describe("normalizePath", () => {
  it("strips leading and trailing slashes", () => {
    expect(normalizePath("/tokens/")).toBe("tokens");
    expect(normalizePath("a/b/")).toBe("a/b");
  });
  it("returns empty string unchanged", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath("   ")).toBe("");
  });
});

describe("normalizeHost", () => {
  it("trims and strips trailing slashes", () => {
    expect(normalizeHost(" https://gitlab.com/ ")).toBe("https://gitlab.com");
    expect(normalizeHost("https://gl.example.com//")).toBe("https://gl.example.com");
    expect(normalizeHost("")).toBe("");
  });
});

describe("withDefaults", () => {
  it("fills missing provider and host on legacy stored settings", () => {
    expect(withDefaults({ owner: "me", repo: "tokens", branch: "main", path: "tokens" })).toEqual({
      provider: "github", owner: "me", repo: "tokens", branch: "main", path: "tokens", host: "",
    });
  });
  it("preserves gitlab provider and host", () => {
    expect(withDefaults(gl)).toEqual(gl);
  });
  it("defaults branch to main and path/host to empty when absent", () => {
    expect(withDefaults({})).toEqual({ provider: "github", owner: "", repo: "", branch: "main", path: "", host: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/settings.test.ts`
Expected: FAIL — `withDefaults`/`normalizeHost` not exported; `Settings` missing `provider`/`host`.

- [ ] **Step 3: Replace `src/settings.ts`**

Replace the entire contents of `src/settings.ts` with:

```ts
// src/settings.ts
// Git target settings + pure helpers. clientStorage I/O lives in main.ts
// (this module stays pure and testable).

export type GitProviderKind = "github" | "gitlab";

export interface Settings {
  provider: GitProviderKind;
  owner: string;
  repo: string;
  branch: string;
  /** Repo-relative folder for the token files; "" = repo root. */
  path: string;
  /** GitLab base host, e.g. "https://gitlab.example.com"; "" = gitlab.com. Ignored for GitHub. */
  host: string;
}

export function normalizePath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

export function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/g, "");
}

/** Fill defaults so settings stored before GitLab support keep working. */
export function withDefaults(stored: Partial<Settings> | null | undefined): Settings {
  return {
    provider: stored?.provider === "gitlab" ? "gitlab" : "github",
    owner: stored?.owner ?? "",
    repo: stored?.repo ?? "",
    branch: stored?.branch ?? "main",
    path: stored?.path ?? "",
    host: stored?.host ?? "",
  };
}

export function validateSettings(s: Settings): string[] {
  const errors: string[] = [];
  if (!s.owner.trim()) errors.push("owner is required");
  if (!s.repo.trim()) errors.push("repo is required");
  if (!s.branch.trim()) errors.push("branch is required");
  if (s.provider !== "github" && s.provider !== "gitlab") errors.push("provider must be github or gitlab");
  if (s.provider === "gitlab" && s.host.trim() && !/^https?:\/\//i.test(s.host.trim())) {
    errors.push("host must start with http:// or https://");
  }
  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/settings.test.ts
git commit -m "feat: settings gain provider/host with defaults for GitLab"
```

---

## Task 2: GitLab provider

**Files:**
- Create: `src/git/gitlab.ts`
- Test: `src/git/gitlab.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/git/gitlab.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGitLabProvider } from "./gitlab";
import type { CommitRequest, ReadRequest } from "./provider";

const HOST = "https://gitlab.com";

function commitReq(): CommitRequest {
  return {
    owner: "group",
    repo: "tokens",
    branch: "main",
    message: "msg",
    token: "TKN",
    files: [
      { path: "tokens/f0.tokens.json", content: '{"i":0}' },
      { path: "tokens/f1.tokens.json", content: '{"i":1}' },
    ],
  };
}

function readReq(path = "tokens"): ReadRequest {
  return { owner: "group", repo: "tokens", branch: "main", path, token: "TKN" };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Routes GitLab REST v4 calls by method + URL; per-call overrides by status. */
function mockFetch(overrides: { tree?: number; commit?: number; raw?: number } = {}) {
  const calls: Array<{ method: string; url: string; body: any; token: any }> = [];
  const fn = async (url: string, init?: any): Promise<Response> => {
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, token: init?.headers?.["PRIVATE-TOKEN"] });
    if (method === "GET" && url.includes("/repository/tree")) {
      if (overrides.tree === -1) throw new Error("network down");
      if (overrides.tree) return new Response("", { status: overrides.tree });
      return json([
        { type: "blob", name: "f0.tokens.json", path: "tokens/f0.tokens.json" },
        { type: "blob", name: "README.md", path: "tokens/README.md" },
      ]);
    }
    if (method === "POST" && url.includes("/repository/commits")) {
      if (overrides.commit === -1) throw new Error("network down");
      if (overrides.commit) return new Response("", { status: overrides.commit });
      return json({ id: "NEWSHA", web_url: "https://gitlab.com/group/tokens/-/commit/NEWSHA" });
    }
    if (method === "GET" && url.includes("/repository/files/")) {
      if (overrides.raw === -1) throw new Error("network down");
      if (overrides.raw) return new Response("", { status: overrides.raw });
      return new Response('{"color":{}}', { status: 200 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("createGitLabProvider.commit", () => {
  it("updates existing files and creates new ones in one atomic commit", async () => {
    // tree reports f0 exists, f1 does not -> mixed actions
    const calls: any[] = [];
    const fn = (async (url: string, init?: any): Promise<Response> => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "GET" && url.includes("/repository/tree")) {
        return json([{ type: "blob", name: "f0.tokens.json", path: "tokens/f0.tokens.json" }]);
      }
      if (method === "POST" && url.includes("/repository/commits")) {
        return json({ id: "NEWSHA", web_url: "https://gitlab.com/group/tokens/-/commit/NEWSHA" });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const result = await createGitLabProvider(HOST, fn).commit(commitReq());
    expect(result).toEqual({ sha: "NEWSHA", commitUrl: "https://gitlab.com/group/tokens/-/commit/NEWSHA" });

    const treeGet = calls.find((c) => c.url.includes("/repository/tree"))!;
    expect(treeGet.url).toContain("/api/v4/projects/group%2Ftokens/repository/tree");
    expect(treeGet.url).toContain("ref=main");
    expect(treeGet.url).toContain("path=tokens");

    const post = calls.find((c) => c.url.includes("/repository/commits"))!;
    expect(post.body.branch).toBe("main");
    expect(post.body.commit_message).toBe("msg");
    expect(post.body.actions).toEqual([
      { action: "update", file_path: "tokens/f0.tokens.json", content: '{"i":0}' },
      { action: "create", file_path: "tokens/f1.tokens.json", content: '{"i":1}' },
    ]);
  });

  it("creates all files when the repo/branch is empty (tree 404)", async () => {
    const { fn, calls } = mockFetch({ tree: 404 });
    const result = await createGitLabProvider(HOST, fn).commit(commitReq());
    expect(result.sha).toBe("NEWSHA");
    const post = calls.find((c) => c.url.includes("/repository/commits"))!;
    expect(post.body.actions.every((a: any) => a.action === "create")).toBe(true);
    expect(post.body.actions.length).toBe(2);
  });

  it("sends the PRIVATE-TOKEN header", async () => {
    const { fn, calls } = mockFetch();
    await createGitLabProvider(HOST, fn).commit(commitReq());
    expect(calls.every((c) => c.token === "TKN")).toBe(true);
  });

  it("maps 401 to auth", async () => {
    const { fn } = mockFetch({ commit: 401 });
    await expect(createGitLabProvider(HOST, fn).commit(commitReq())).rejects.toMatchObject({ kind: "auth" });
  });

  it("maps a thrown fetch to network", async () => {
    const { fn } = mockFetch({ tree: -1 });
    await expect(createGitLabProvider(HOST, fn).commit(commitReq())).rejects.toMatchObject({ kind: "network" });
  });
});

describe("createGitLabProvider.readFiles", () => {
  it("lists *.tokens.json from the tree and fetches raw content", async () => {
    const { fn, calls } = mockFetch();
    const files = await createGitLabProvider(HOST, fn).readFiles(readReq());
    expect(files).toEqual([{ filename: "f0.tokens.json", content: '{"color":{}}' }]);
    const raw = calls.find((c) => c.url.includes("/repository/files/"))!;
    expect(raw.url).toContain("/repository/files/tokens%2Ff0.tokens.json/raw");
    expect(raw.url).toContain("ref=main");
  });

  it("throws no-tokens when the folder has no token files", async () => {
    const fn = (async (url: string, init?: any): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/repository/tree")) {
        return json([{ type: "blob", name: "README.md", path: "tokens/README.md" }]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;
    await expect(createGitLabProvider(HOST, fn).readFiles(readReq())).rejects.toMatchObject({ kind: "no-tokens" });
  });

  it("maps 404 on the tree to not-found", async () => {
    const { fn } = mockFetch({ tree: 404 });
    await expect(createGitLabProvider(HOST, fn).readFiles(readReq())).rejects.toMatchObject({ kind: "not-found" });
  });

  it("uses the configured self-hosted host", async () => {
    const { fn, calls } = mockFetch();
    await createGitLabProvider("https://gl.example.com", fn).readFiles(readReq());
    expect(calls[0].url.startsWith("https://gl.example.com/api/v4/")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/git/gitlab.test.ts`
Expected: FAIL — module `./gitlab` not found.

- [ ] **Step 3: Implement `src/git/gitlab.ts`**

Create `src/git/gitlab.ts`:

```ts
// GitLab GitProvider using the REST v4 Commits API so all token files land in
// ONE atomic commit. fetch is injected for testability. Host is configurable
// (gitlab.com or a self-hosted instance). Project is the URL-encoded
// "owner/repo" path; PAT auth via the PRIVATE-TOKEN header.

import {
  CommitError,
  type CommitRequest,
  type CommitResult,
  type GitProvider,
  type ReadFile,
  type ReadRequest,
} from "./provider";

function headers(token: string): Record<string, string> {
  return { "PRIVATE-TOKEN": token, "Content-Type": "application/json" };
}

function mapHttpError(status: number, text: string): CommitError {
  if (status === 401 || status === 403) {
    return new CommitError("auth", "GitLab token invalid or missing api / write_repository scope");
  }
  if (status === 404) {
    return new CommitError("not-found", "Project or branch not found — check owner/repo/branch/host");
  }
  return new CommitError("unexpected", `GitLab API ${status}: ${text.slice(0, 200)}`);
}

/** Folder portion of a repo-relative file path ("tokens/x.json" -> "tokens", "x.json" -> ""). */
function folderOf(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? "" : filePath.slice(0, i);
}

export function createGitLabProvider(host: string, fetchFn: typeof fetch = fetch): GitProvider {
  const base = `${host}/api/v4`;

  async function send(method: string, url: string, token: string, body?: unknown): Promise<Response> {
    try {
      return await fetchFn(url, {
        method,
        headers: headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new CommitError("network", `Network error reaching ${host}: ${msg}`);
    }
  }

  async function call(method: string, url: string, token: string, body?: unknown): Promise<any> {
    const res = await send(method, url, token, body);
    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ""));
    return res.json();
  }

  async function callRaw(url: string, token: string): Promise<string> {
    const res = await send("GET", url, token);
    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ""));
    return res.text();
  }

  function treeUrl(project: string, folder: string, branch: string): string {
    const q = `ref=${encodeURIComponent(branch)}&per_page=100${folder ? `&path=${encodeURIComponent(folder)}` : ""}`;
    return `${base}/projects/${project}/repository/tree?${q}`;
  }

  /** Existing blob paths in `folder` on `branch`, or null when the repo/branch is empty (404). */
  async function existingPaths(project: string, folder: string, branch: string, token: string): Promise<Set<string> | null> {
    const res = await send("GET", treeUrl(project, folder, branch), token);
    if (res.status === 404) return null;
    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ""));
    const tree = (await res.json()) as Array<{ type: string; path: string }>;
    return new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
  }

  return {
    async commit(req: CommitRequest): Promise<CommitResult> {
      const project = encodeURIComponent(`${req.owner}/${req.repo}`);
      const folder = req.files.length ? folderOf(req.files[0].path) : "";
      const existing = await existingPaths(project, folder, req.branch, req.token);
      const actions = req.files.map((f) => ({
        action: existing && existing.has(f.path) ? "update" : "create",
        file_path: f.path,
        content: f.content,
      }));
      const body = await call("POST", `${base}/projects/${project}/repository/commits`, req.token, {
        branch: req.branch,
        commit_message: req.message,
        actions,
      });
      return { sha: body.id as string, commitUrl: body.web_url as string };
    },

    async readFiles(req: ReadRequest): Promise<ReadFile[]> {
      const project = encodeURIComponent(`${req.owner}/${req.repo}`);
      const tree = (await call("GET", treeUrl(project, req.path, req.branch), req.token)) as Array<{
        type: string;
        name: string;
        path: string;
      }>;
      const entries = tree.filter((e) => e.type === "blob" && e.name.endsWith(".tokens.json"));
      if (entries.length === 0) {
        throw new CommitError("no-tokens", "No *.tokens.json files found at the configured path");
      }
      const files: ReadFile[] = [];
      for (const e of entries) {
        const url = `${base}/projects/${project}/repository/files/${encodeURIComponent(e.path)}/raw?ref=${encodeURIComponent(req.branch)}`;
        files.push({ filename: e.name, content: await callRaw(url, req.token) });
      }
      return files;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/git/gitlab.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test` — Expected: all pass. Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/git/gitlab.ts src/git/gitlab.test.ts
git commit -m "feat: GitLab provider (REST v4 atomic commit + readFiles)"
```

---

## Task 3: Provider selector

**Files:**
- Create: `src/git/select.ts`
- Test: `src/git/select.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/git/select.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectProvider } from "./select";
import type { Settings } from "../settings";

function recordingFetch() {
  const urls: string[] = [];
  const fn = (async (url: string): Promise<Response> => {
    urls.push(url);
    throw new Error("stop");
  }) as unknown as typeof fetch;
  return { fn, urls };
}

const base: Settings = { provider: "github", owner: "g", repo: "p", branch: "main", path: "tokens", host: "" };
const readReq = { owner: "g", repo: "p", branch: "main", path: "tokens", token: "t" };

describe("selectProvider", () => {
  it("routes github to api.github.com", async () => {
    const { fn, urls } = recordingFetch();
    await selectProvider({ ...base, provider: "github" }, fn).readFiles(readReq).catch(() => {});
    expect(urls[0].startsWith("https://api.github.com/")).toBe(true);
  });

  it("routes gitlab to gitlab.com by default (empty host)", async () => {
    const { fn, urls } = recordingFetch();
    await selectProvider({ ...base, provider: "gitlab", host: "" }, fn).readFiles(readReq).catch(() => {});
    expect(urls[0].startsWith("https://gitlab.com/api/v4/")).toBe(true);
  });

  it("routes gitlab to a configured self-hosted host", async () => {
    const { fn, urls } = recordingFetch();
    await selectProvider({ ...base, provider: "gitlab", host: "https://gl.example.com/" }, fn).readFiles(readReq).catch(() => {});
    expect(urls[0].startsWith("https://gl.example.com/api/v4/")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/git/select.test.ts`
Expected: FAIL — module `./select` not found.

- [ ] **Step 3: Implement `src/git/select.ts`**

Create `src/git/select.ts`:

```ts
// Picks the git provider from settings. Host is GitLab construction config
// (gitlab.com when empty); GitHub ignores it. The GitProvider contract is the
// same for both, so callers don't branch on provider.

import { normalizeHost, type Settings } from "../settings";
import { createGitHubProvider } from "./github";
import { createGitLabProvider } from "./gitlab";
import type { GitProvider } from "./provider";

const GITLAB_DEFAULT_HOST = "https://gitlab.com";

export function selectProvider(settings: Settings, fetchFn: typeof fetch = fetch): GitProvider {
  if (settings.provider === "gitlab") {
    return createGitLabProvider(normalizeHost(settings.host) || GITLAB_DEFAULT_HOST, fetchFn);
  }
  return createGitHubProvider(fetchFn);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/git/select.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git/select.ts src/git/select.test.ts
git commit -m "feat: selectProvider routes settings to GitHub or GitLab"
```

---

## Task 4: Wire the selector into main.ts

**Files:**
- Modify: `src/main.ts`

> Impure (clientStorage + figma.*) — verify via `npm run typecheck`; manual QA in Task 6.

- [ ] **Step 1: Update imports**

In `src/main.ts`, replace the import line:

```ts
import { createGitHubProvider } from "./git/github";
```

with:

```ts
import { selectProvider } from "./git/select";
```

And replace the settings import:

```ts
import { normalizePath, type Settings, validateSettings } from "./settings";
```

with:

```ts
import { normalizePath, type Settings, validateSettings, withDefaults } from "./settings";
```

- [ ] **Step 2: Default stored settings on load**

In `loadSettings`, replace:

```ts
  return { settings: settings ?? null, tokenSet: Boolean(token) };
```

with:

```ts
  return { settings: settings ? withDefaults(settings) : null, tokenSet: Boolean(token) };
```

- [ ] **Step 3: Use the selected provider in IMPORT_GITHUB**

In the `IMPORT_GITHUB` handler, replace:

```ts
    const settings = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Settings | undefined;
    const token = (await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined;
    if (!settings || !token) {
      emit("IMPORT_ERROR", { kind: "auth", message: "Configure repo settings and a token first" });
      return;
    }
    try {
      const read = await createGitHubProvider().readFiles({
        owner: settings.owner,
        repo: settings.repo,
        branch: settings.branch,
        path: normalizePath(settings.path),
        token,
      });
```

with:

```ts
    const stored = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Settings | undefined;
    const token = (await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined;
    if (!stored || !token) {
      emit("IMPORT_ERROR", { kind: "auth", message: "Configure repo settings and a token first" });
      return;
    }
    const settings = withDefaults(stored);
    try {
      const read = await selectProvider(settings).readFiles({
        owner: settings.owner,
        repo: settings.repo,
        branch: settings.branch,
        path: normalizePath(settings.path),
        token,
      });
```

- [ ] **Step 4: Use the selected provider in COMMIT**

In the `COMMIT` handler, replace:

```ts
    const settings = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Settings | undefined;
    const token = (await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined;
    if (!settings || !token) {
      emit("COMMIT_ERROR", { kind: "auth", message: "Configure repo settings and a token first" });
      return;
    }
    try {
```

with:

```ts
    const stored = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Settings | undefined;
    const token = (await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined;
    if (!stored || !token) {
      emit("COMMIT_ERROR", { kind: "auth", message: "Configure repo settings and a token first" });
      return;
    }
    const settings = withDefaults(stored);
    try {
```

And in the same handler replace:

```ts
      const result = await createGitHubProvider().commit({
```

with:

```ts
      const result = await selectProvider(settings).commit({
```

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck` — Expected: clean.
Run: `npm test` — Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat: main.ts commits/imports via the selected provider"
```

---

## Task 5: UI — provider toggle + host field

**Files:**
- Modify: `src/ui.tsx`

> Impure (Preact UI) — verify via `npm run typecheck`; manual QA in Task 6.

- [ ] **Step 1: Update the EMPTY default**

In `src/ui.tsx`, replace:

```ts
const EMPTY: Settings = { owner: "", repo: "", branch: "main", path: "tokens" };
```

with:

```ts
const EMPTY: Settings = { provider: "github", owner: "", repo: "", branch: "main", path: "tokens", host: "" };
```

- [ ] **Step 2: Replace the provider-label + target fields block**

In the returned JSX, replace this block:

```tsx
      <Text>GitHub target</Text>
      <VerticalSpace space="small" />
      <Textbox onValueInput={set("owner")} value={s.owner} placeholder="owner" />
```

with:

```tsx
      <Text>Git provider</Text>
      <VerticalSpace space="small" />
      <div style={{ display: "flex", gap: 6 }}>
        <Button secondary={s.provider !== "github"} onClick={() => setS({ ...s, provider: "github" })}>
          GitHub
        </Button>
        <Button secondary={s.provider !== "gitlab"} onClick={() => setS({ ...s, provider: "gitlab" })}>
          GitLab
        </Button>
      </div>
      <VerticalSpace space="small" />
      {s.provider === "gitlab" ? (
        <Fragment>
          <Textbox onValueInput={set("host")} value={s.host} placeholder="https://gitlab.com (or your instance)" />
          <VerticalSpace space="small" />
          <Text>Self-hosted: add your host to package.json networkAccess and rebuild.</Text>
          <VerticalSpace space="small" />
        </Fragment>
      ) : null}
      <Textbox onValueInput={set("owner")} value={s.owner} placeholder={s.provider === "gitlab" ? "group (or group/subgroup)" : "owner"} />
```

- [ ] **Step 3: Make the commit button label provider-aware**

Replace:

```tsx
        Commit to GitHub
```

with:

```tsx
        {`Commit to ${s.provider === "gitlab" ? "GitLab" : "GitHub"}`}
```

- [ ] **Step 4: Import `Fragment`**

Replace the preact import:

```ts
import { h } from "preact";
```

with:

```ts
import { Fragment, h } from "preact";
```

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck` — Expected: clean.
Run: `npm run build` — Expected: success.

- [ ] **Step 6: Commit**

```bash
git add src/ui.tsx
git commit -m "feat: provider toggle and GitLab host field in the UI"
```

---

## Task 6: networkAccess, docs, build, QA

**Files:**
- Modify: `package.json`, `README.md`

- [ ] **Step 1: Add gitlab.com to networkAccess**

In `package.json`, in the `figma-plugin.networkAccess` block, replace:

```json
    "networkAccess": {
      "allowedDomains": ["https://api.github.com"],
      "reasoning": "Commit exported design tokens to the configured GitHub repository."
    }
```

with:

```json
    "networkAccess": {
      "allowedDomains": ["https://api.github.com", "https://gitlab.com"],
      "reasoning": "Commit and read design tokens to/from the configured GitHub or GitLab repository. Self-hosted GitLab instances must be added here."
    }
```

- [ ] **Step 2: Full test + build**

Run: `npm test` — Expected: all pass.
Run: `npm run build` — Expected: typecheck passes; regenerates `manifest.json` + `build/`.

- [ ] **Step 3: Document in README**

In `README.md`, under the GitHub/Commit documentation, add a section:

```markdown
## GitLab

Select **GitLab** as the provider in the plugin. It works like GitHub (commit + import):

1. Create a **Personal Access Token** with the `api` scope (or
   `read_repository` + `write_repository`).
2. Fill in **owner** (the group, e.g. `group` or `group/subgroup`), **repo** (the
   project), **branch**, **path**, and the **host** (blank = `gitlab.com`).
3. Commit / import as usual. A brand-new empty project is initialized on the first
   commit (GitLab creates the branch and files in one commit).

**Self-hosted GitLab:** Figma only allows network requests to domains listed in
the manifest. Add your instance to `package.json` →
`figma-plugin.networkAccess.allowedDomains` (e.g. `"https://gitlab.example.com"`)
and run `npm run build`, then re-import the manifest in Figma.
```

Also update the **Limitations** section: change the bullet about providers to note GitLab is now supported (OAuth and other providers remain out of scope).

- [ ] **Step 4: Manual QA checklist (run in Figma)**

You CANNOT run Figma automatically — perform these in the Figma desktop app
(Quick Actions → Import plugin from manifest… → select `manifest.json`):

- [ ] Provider = GitLab, fill owner/repo/branch/path/host (blank), paste a GitLab PAT, Save settings.
- [ ] **Commit to GitLab** into an existing project → commit URL appears; the six `*.tokens.json` land in one commit.
- [ ] **Commit to GitLab** into a brand-new empty project → branch + files created in one commit.
- [ ] **Preview from GitHub/GitLab** (import) with GitLab selected → reads the token files; diff preview appears.
- [ ] Switch provider back to GitHub → existing GitHub commit/import still works (no regression).
- [ ] Bad host (`gitlab.example.com` without scheme) → Save shows the host validation error.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md
git commit -m "docs: document GitLab provider; allow gitlab.com network access"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** provider/host settings + withDefaults (Task 1); GitLab commit create/update + empty-repo + readFiles + error mapping (Task 2); selectProvider routing incl. self-hosted host (Task 3); main wiring with no contract change (Task 4); provider toggle + host field + self-hosted hint (Task 5); networkAccess + README + manual QA (Task 6). All covered.
- **Type consistency:** `Settings` (provider/owner/repo/branch/path/host) defined in Task 1 and used identically in select.ts, main.ts, ui.tsx. `createGitLabProvider(host, fetchFn)` signature matches its use in select.ts. `GitProvider` contract unchanged — `commit`/`readFiles` requests keep `owner/repo/branch/path/token`.
- **Boundary:** decision/IO logic in pure, tested modules (settings, gitlab provider, select); `main.ts`/`ui.tsx` stay impure and thin.
