// src/git/provider.ts
// Provider-agnostic git commit contract. Only GitHub is implemented in v1,
// but the interface lets GitLab/etc. be added without touching callers.

export interface GitFile {
  /** Repo-relative path, e.g. "tokens/color.tokens.json". */
  path: string;
  /** UTF-8 file content. */
  content: string;
}

export interface CommitRequest {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: GitFile[];
  token: string;
}

export interface CommitResult {
  /** New commit sha. */
  sha: string;
  /** html_url of the new commit. */
  commitUrl: string;
}

export type CommitErrorKind =
  | "auth"
  | "not-found"
  | "empty-repo"
  | "no-tokens"
  | "network"
  | "unexpected";

export class CommitError extends Error {
  constructor(public readonly kind: CommitErrorKind, message: string) {
    super(message);
    this.name = "CommitError";
  }
}

export interface GitProvider {
  commit(req: CommitRequest): Promise<CommitResult>;
  readFiles(req: ReadRequest): Promise<ReadFile[]>;
}

export interface ReadRequest {
  owner: string;
  repo: string;
  branch: string;
  /** Repo-relative folder; "" = repo root. */
  path: string;
  token: string;
}

export interface ReadFile {
  filename: string;
  content: string;
}
