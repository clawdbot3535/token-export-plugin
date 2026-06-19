import { emit, on, showUI } from "@create-figma-plugin/utilities";
import { buildExport } from "./export";
import { collect } from "./collect";
import { selectProvider } from "./git/select";
import { CommitError, type GitFile } from "./git/provider";
import { normalizePath, type Settings, validateSettings, withDefaults } from "./settings";
import { buildPlan, type ImportPlan } from "./diff";
import { applyPlan } from "./figma-write";
import { type ImportFile, parse } from "./parse";

const SETTINGS_KEY = "tokenexport.settings";
const TOKEN_KEY = "tokenexport.token";


async function loadSettings(): Promise<{ settings: Settings | null; tokenSet: boolean }> {
  const settings = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Settings | undefined;
  const token = (await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined;
  return { settings: settings ? withDefaults(settings) : null, tokenSet: Boolean(token) };
}

function planSummary(plan: ImportPlan) {
  return {
    creates: plan.creates.length,
    updates: plan.updates.length,
    unchanged: plan.unchangedCount,
    collectionsToCreate: plan.collectionsToCreate,
    modesToAdd: plan.modesToAdd,
    createNames: plan.creates.map((c) => `${c.collection}/${c.name}`),
    updateNames: plan.updates.map((c) => `${c.collection}/${c.name}`),
    warnings: plan.warnings,
  };
}

function importError(err: unknown): { kind: string; message: string } {
  if (err instanceof CommitError) return { kind: err.kind, message: err.message };
  return { kind: "unexpected", message: err instanceof Error ? err.message : String(err) };
}

export default function (): void {
  showUI({ width: 320, height: 480 });

  loadSettings().then((s) => emit("SETTINGS_LOADED", s));

  on("SAVE_SETTINGS", async function (payload: { settings: Settings; token?: string }) {
    const errors = validateSettings(payload.settings);
    if (errors.length > 0) {
      emit("SETTINGS_ERROR", errors.join("; "));
      return;
    }
    const normalized: Settings = { ...payload.settings, path: normalizePath(payload.settings.path) };
    await figma.clientStorage.setAsync(SETTINGS_KEY, normalized);
    if (payload.token && payload.token.trim()) {
      await figma.clientStorage.setAsync(TOKEN_KEY, payload.token.trim());
    }
    emit("SETTINGS_LOADED", await loadSettings());
  });

  on("EXPORT_ZIP", async function () {
    try {
      emit("ZIP_FILES", buildExport(await collect()));
    } catch (err) {
      emit("COMMIT_ERROR", { kind: "unexpected", message: err instanceof Error ? err.message : String(err) });
    }
  });

  let lastImportFiles: ImportFile[] | null = null;

  on("IMPORT_GITHUB", async function () {
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
      const files: ImportFile[] = read.map((r) => ({ filename: r.filename, json: r.content }));
      lastImportFiles = files;
      const plan = buildPlan(parse(files), await collect());
      emit("IMPORT_PLAN", planSummary(plan));
    } catch (err) {
      emit("IMPORT_ERROR", importError(err));
    }
  });

  on("IMPORT_LOCAL", async function (payload: { files: ImportFile[] }) {
    try {
      lastImportFiles = payload.files;
      const plan = buildPlan(parse(payload.files), await collect());
      emit("IMPORT_PLAN", planSummary(plan));
    } catch (err) {
      emit("IMPORT_ERROR", importError(err));
    }
  });

  on("IMPORT_APPLY", async function () {
    if (!lastImportFiles) {
      emit("IMPORT_ERROR", { kind: "unexpected", message: "Nothing to apply — preview first" });
      return;
    }
    try {
      const plan = buildPlan(parse(lastImportFiles), await collect());
      const summary = await applyPlan(plan);
      emit("IMPORT_DONE", summary);
    } catch (err) {
      emit("IMPORT_ERROR", importError(err));
    }
  });

  on("COMMIT", async function (payload: { message?: string }) {
    const stored = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Settings | undefined;
    const token = (await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined;
    if (!stored || !token) {
      emit("COMMIT_ERROR", { kind: "auth", message: "Configure repo settings and a token first" });
      return;
    }
    const settings = withDefaults(stored);
    try {
      const { files } = buildExport(await collect());
      const path = normalizePath(settings.path);
      const gitFiles: GitFile[] = files.map((f) => ({
        path: path ? `${path}/${f.filename}` : f.filename,
        content: f.json,
      }));
      const message =
        payload.message && payload.message.trim()
          ? payload.message.trim()
          : `Update design tokens (${files.length} files) — ${new Date().toISOString()}`;
      const result = await selectProvider(settings).commit({
        owner: settings.owner,
        repo: settings.repo,
        branch: settings.branch,
        message,
        files: gitFiles,
        token,
      });
      emit("COMMIT_RESULT", { commitUrl: result.commitUrl });
    } catch (err) {
      if (err instanceof CommitError) {
        emit("COMMIT_ERROR", { kind: err.kind, message: err.message });
      } else {
        emit("COMMIT_ERROR", { kind: "unexpected", message: err instanceof Error ? err.message : String(err) });
      }
    }
  });
}
