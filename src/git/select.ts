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
