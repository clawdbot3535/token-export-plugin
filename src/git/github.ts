// GitHub GitProvider using the Git Data API so all token files land in ONE
// commit. fetch is injected for testability (defaults to the global Fetch API,
// which Figma exposes in the plugin main thread).
//
// Empty repositories: the Git Data API cannot create objects without an
// existing commit (POST /git/blobs returns 409 on a zero-commit repo), so we
// bootstrap an initial commit + branch via the Contents API, then build the
// token commit on top via the normal Git Data path.

import {
  CommitError,
  type CommitRequest,
  type CommitResult,
  type GitProvider,
  type ReadFile,
  type ReadRequest,
} from "./provider";

const API = "https://api.github.com";

// base64 of "# Design tokens\n" — hardcoded so no runtime base64 encoder is
// needed (btoa is not guaranteed in the Figma main thread).
const README_CONTENT_B64 = "IyBEZXNpZ24gdG9rZW5zCg==";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function mapHttpError(status: number, text: string): CommitError {
  if (status === 401 || status === 403) {
    return new CommitError("auth", "GitHub token invalid or missing Contents write permission");
  }
  if (status === 404) {
    return new CommitError("not-found", "Repo or branch not found — check owner/repo/branch");
  }
  if (status === 409) {
    return new CommitError("empty-repo", "Target branch has no commits yet");
  }
  return new CommitError("unexpected", `GitHub API ${status}: ${text.slice(0, 200)}`);
}

export function createGitHubProvider(fetchFn: typeof fetch = fetch): GitProvider {
  async function call(method: string, url: string, token: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method,
        headers: headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new CommitError("network", `Network error reaching api.github.com: ${msg}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw mapHttpError(res.status, text);
    }
    return res.json();
  }

  async function callRaw(url: string, token: string): Promise<string> {
    let res: Response;
    try {
      res = await fetchFn(url, { method: "GET", headers: { ...headers(token), Accept: "application/vnd.github.raw" } });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new CommitError("network", `Network error reaching api.github.com: ${msg}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw mapHttpError(res.status, text);
    }
    return res.text();
  }

  /** Base commit sha for the branch, or null when the repo/branch has no commits yet. */
  async function getBaseSha(base: string, branch: string, token: string): Promise<string | null> {
    let res: Response;
    try {
      res = await fetchFn(`${base}/git/ref/heads/${branch}`, { method: "GET", headers: headers(token) });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new CommitError("network", `Network error reaching api.github.com: ${msg}`);
    }
    if (res.status === 409) return null; // empty repository — no commits yet
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw mapHttpError(res.status, text);
    }
    const body = await res.json();
    return body.object.sha as string;
  }

  return {
    async commit(req: CommitRequest): Promise<CommitResult> {
      const base = `${API}/repos/${req.owner}/${req.repo}`;

      let baseSha = await getBaseSha(base, req.branch, req.token);
      let baseTree: string;

      if (baseSha === null) {
        // Empty repo: bootstrap an initial commit + branch via the Contents API.
        const init = await call("PUT", `${base}/contents/README.md`, req.token, {
          message: "Initialize repository",
          content: README_CONTENT_B64,
          branch: req.branch,
        });
        baseSha = init.commit.sha as string;
        baseTree = init.commit.tree.sha as string;
      } else {
        const baseCommit = await call("GET", `${base}/git/commits/${baseSha}`, req.token);
        baseTree = baseCommit.tree.sha as string;
      }

      const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      for (const f of req.files) {
        const blob = await call("POST", `${base}/git/blobs`, req.token, {
          content: f.content,
          encoding: "utf-8",
        });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }

      const newTree = await call("POST", `${base}/git/trees`, req.token, {
        base_tree: baseTree,
        tree,
      });

      const commit = await call("POST", `${base}/git/commits`, req.token, {
        message: req.message,
        tree: newTree.sha,
        parents: [baseSha],
      });

      await call("PATCH", `${base}/git/refs/heads/${req.branch}`, req.token, { sha: commit.sha });

      return { sha: commit.sha, commitUrl: commit.html_url };
    },
    async readFiles(req: ReadRequest): Promise<ReadFile[]> {
      const base = `${API}/repos/${req.owner}/${req.repo}`;
      const ref = encodeURIComponent(req.branch);
      const dirUrl = req.path ? `${base}/contents/${req.path}?ref=${ref}` : `${base}/contents?ref=${ref}`;
      const listing = await call("GET", dirUrl, req.token);
      if (!Array.isArray(listing)) {
        throw new CommitError("not-found", "Configured token path is a file, not a folder");
      }
      const entries = (listing as Array<{ type: string; name: string; path: string }>).filter(
        (e) => e.type === "file" && e.name.endsWith(".tokens.json"),
      );
      if (entries.length === 0) {
        throw new CommitError("no-tokens", "No *.tokens.json files found at the configured path");
      }
      const files: ReadFile[] = [];
      for (const e of entries) {
        const content = await callRaw(`${base}/contents/${e.path}?ref=${ref}`, req.token);
        files.push({ filename: e.name, content });
      }
      return files;
    },
  };
}
