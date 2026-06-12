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
