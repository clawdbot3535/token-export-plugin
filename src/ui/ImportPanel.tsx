import { Button, Text, VerticalSpace } from "@create-figma-plugin/ui";
import { emit, on } from "@create-figma-plugin/utilities";
import { strFromU8, unzipSync } from "fflate";
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ImportFile } from "../parse";

interface PlanSummary {
  creates: number;
  updates: number;
  unchanged: number;
  collectionsToCreate: string[];
  modesToAdd: { collection: string; mode: string }[];
  createNames: string[];
  updateNames: string[];
  warnings: string[];
}

interface DoneSummary {
  createdCollections: number;
  createdVariables: number;
  updatedVariables: number;
  errors: string[];
}

export function ImportPanel() {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [status, setStatus] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offPlan = on("IMPORT_PLAN", (p: PlanSummary) => {
      setPlan(p);
      const warn = p.warnings.length ? ` · ${p.warnings.length} warnings` : "";
      setStatus(`${p.creates} new · ${p.updates} changed · ${p.unchanged} unchanged${warn}`);
    });
    const offDone = on("IMPORT_DONE", (s: DoneSummary) => {
      setPlan(null);
      const errs = s.errors.length ? ` · ${s.errors.length} errors` : "";
      setStatus(`Imported: +${s.createdVariables} vars, ${s.updatedVariables} updated, +${s.createdCollections} collections${errs}`);
    });
    const offErr = on("IMPORT_ERROR", (p: { kind: string; message: string }) => {
      setPlan(null);
      setStatus(`Import error (${p.kind}): ${p.message}`);
    });
    return () => {
      offPlan();
      offDone();
      offErr();
    };
  }, []);

  async function onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const list = input.files;
    if (!list || list.length === 0) return;
    try {
      const files: ImportFile[] = [];
      for (const f of Array.from(list)) {
        const buf = new Uint8Array(await f.arrayBuffer());
        if (f.name.endsWith(".zip")) {
          const unzipped = unzipSync(buf);
          for (const [name, bytes] of Object.entries(unzipped)) {
            if (name.endsWith(".tokens.json")) files.push({ filename: name.split("/").pop() as string, json: strFromU8(bytes) });
          }
        } else if (f.name.endsWith(".json")) {
          files.push({ filename: f.name, json: strFromU8(buf) });
        }
      }
      input.value = "";
      if (files.length === 0) {
        setStatus("No *.tokens.json found in selection");
        return;
      }
      setStatus("Reading files…");
      emit("IMPORT_LOCAL", { files });
    } catch (err) {
      input.value = "";
      setStatus(`Could not read files: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div>
      <Text>Import from repo</Text>
      <VerticalSpace space="small" />
      <Button
        secondary
        fullWidth
        onClick={() => {
          setStatus("Reading from GitHub…");
          emit("IMPORT_GITHUB");
        }}
      >
        Preview from GitHub
      </Button>
      <VerticalSpace space="small" />
      <Button secondary fullWidth onClick={() => fileRef.current?.click()}>
        Preview from file…
      </Button>
      <input ref={fileRef} type="file" accept=".zip,.json" multiple style={{ display: "none" }} onChange={onFiles} />
      {plan ? (
        <div>
          <VerticalSpace space="small" />
          <Text>
            {plan.creates} new, {plan.updates} changed, {plan.unchanged} unchanged
          </Text>
          <VerticalSpace space="small" />
          <Button
            fullWidth
            onClick={() => {
              setStatus("Applying…");
              emit("IMPORT_APPLY");
            }}
          >
            Apply to Figma
          </Button>
          <VerticalSpace space="small" />
          <Button
            secondary
            fullWidth
            onClick={() => {
              setPlan(null);
              setStatus("Cancelled");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      <VerticalSpace space="small" />
      <Text>{status}</Text>
    </div>
  );
}
