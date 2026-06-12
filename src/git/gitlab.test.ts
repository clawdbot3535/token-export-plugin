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
