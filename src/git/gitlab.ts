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
