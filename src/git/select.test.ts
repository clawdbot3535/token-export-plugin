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
