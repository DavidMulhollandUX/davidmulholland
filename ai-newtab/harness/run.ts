/**
 * Run a real homepage build from Node, outside Chrome.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm harness [--model claude-haiku-5-5] [--history fixtures/history.json] [--instructions "..."]
 *
 * Writes harness/out/homepage.tsx. Agent + environment IDs are cached in harness/.state.json.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL, ensureInfra, MODELS, runBuild, type InfraIds, type ModelId } from "@ai-newtab/agent-core";
import { createNodeHost } from "./nodeHost.js";

const here = dirname(fileURLToPath(import.meta.url));
const statePath = join(here, ".state.json");

const { values } = parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_MODEL },
    history: { type: "string", default: join(here, "fixtures/history.json") },
    instructions: { type: "string", default: "" },
  },
});

const model = values.model as ModelId;
if (!MODELS.some((m) => m.id === model)) {
  console.error(`Unknown model ${model}. Use one of: ${MODELS.map((m) => m.id).join(", ")}`);
  process.exit(1);
}

const client = new Anthropic();
const saved = await readFile(statePath, "utf8").then((s) => JSON.parse(s) as InfraIds, () => null);
const infra = await ensureInfra(client, saved);
await writeFile(statePath, JSON.stringify(infra, null, 2));

const started = Date.now();
const result = await runBuild({
  client,
  infra,
  model,
  instructions: values.instructions!,
  host: createNodeHost(values.history!),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  callbacks: {
    onProgress: (text) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${text}`),
    onCheckpoint: () => {},
  },
});

const out = join(here, "out/homepage.tsx");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, result.tsx);
console.log(`\n${result.summary}\n\nWrote ${out} (${result.pageCount} pages, ${result.tsx.length} chars)`);
