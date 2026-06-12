import { Button, Container, render, Text, Textbox, VerticalSpace } from "@create-figma-plugin/ui";
import { emit, on } from "@create-figma-plugin/utilities";
import { strToU8, zipSync } from "fflate";
import { Fragment, h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ExportResult } from "./export";
import type { Settings } from "./settings";
import { timestampedZipName } from "./timestamp";
import { ImportPanel } from "./ui/ImportPanel";

const EMPTY: Settings = { provider: "github", owner: "", repo: "", branch: "main", path: "tokens", host: "" };

function download(files: ExportResult["files"]): void {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.filename] = strToU8(f.json);
  const blob = new Blob([zipSync(entries)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = timestampedZipName(new Date());
  a.click();
  URL.revokeObjectURL(url);
}

function Plugin() {
  const [s, setS] = useState<Settings>(EMPTY);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenSet, setTokenSet] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const offLoaded = on("SETTINGS_LOADED", (p: { settings: Settings | null; tokenSet: boolean }) => {
      if (p.settings) setS(p.settings);
      setTokenSet(p.tokenSet);
    });
    const offSettingsErr = on("SETTINGS_ERROR", (m: string) => setStatus(`Settings: ${m}`));
    const offCommit = on("COMMIT_RESULT", (p: { commitUrl: string }) => setStatus(`Committed: ${p.commitUrl}`));
    const offCommitErr = on("COMMIT_ERROR", (p: { kind: string; message: string }) =>
      setStatus(`Error (${p.kind}): ${p.message}`),
    );
    const offZip = on("ZIP_FILES", (r: ExportResult) => {
      if (r.files.length === 0) {
        setStatus("No variable collections found.");
        return;
      }
      download(r.files);
      const warn = r.warnings.length ? ` · ${r.warnings.length} warnings` : "";
      setStatus(`Downloaded ${r.files.length} file(s)${warn}`);
    });
    return () => {
      offLoaded();
      offSettingsErr();
      offCommit();
      offCommitErr();
      offZip();
    };
  }, []);

  const set = (k: keyof Settings) => (value: string) => setS({ ...s, [k]: value });

  return (
    <Container space="medium">
      <VerticalSpace space="medium" />
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
      <VerticalSpace space="small" />
      <Textbox onValueInput={set("repo")} value={s.repo} placeholder="repo" />
      <VerticalSpace space="small" />
      <Textbox onValueInput={set("branch")} value={s.branch} placeholder="branch" />
      <VerticalSpace space="small" />
      <Textbox onValueInput={set("path")} value={s.path} placeholder="path (folder, blank = root)" />
      <VerticalSpace space="small" />
      <input
        type="password"
        value={tokenInput}
        placeholder={
          tokenSet
            ? "token set — paste to replace"
            : s.provider === "gitlab"
              ? "PAT (api or write_repository scope)"
              : "fine-grained PAT (Contents: write)"
        }
        onInput={(e) => setTokenInput((e.target as HTMLInputElement).value)}
        style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px" }}
      />
      <VerticalSpace space="small" />
      <Button
        secondary
        fullWidth
        onClick={() => {
          emit("SAVE_SETTINGS", { settings: s, token: tokenInput || undefined });
          setTokenInput("");
          setStatus("Settings saved");
        }}
      >
        Save settings
      </Button>
      <VerticalSpace space="medium" />
      <Button
        fullWidth
        onClick={() => {
          setStatus("Committing…");
          emit("COMMIT", {});
        }}
      >
        {`Commit to ${s.provider === "gitlab" ? "GitLab" : "GitHub"}`}
      </Button>
      <VerticalSpace space="small" />
      <Button
        secondary
        fullWidth
        onClick={() => {
          setStatus("Reading variables…");
          emit("EXPORT_ZIP");
        }}
      >
        Download .zip
      </Button>
      <VerticalSpace space="small" />
      <Text>{status}</Text>
      <VerticalSpace space="medium" />
      <ImportPanel />
    </Container>
  );
}

export default render(Plugin);
