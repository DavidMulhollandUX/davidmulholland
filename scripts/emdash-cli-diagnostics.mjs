#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

function run(args) {
  const r = spawnSync("pnpm", args, { encoding: "utf8" });
  return {
    args,
    status: r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error ? String(r.error) : null,
  };
}

const result = {
  help: run(["exec", "emdash", "--help"]),
  validate: run(["exec", "emdash", "seed", "seed/seed.wp-import.json", "--validate"]),
  apply: run(["exec", "emdash", "seed", "seed/seed.wp-import.json"]),
  timestamp: new Date().toISOString(),
};

await writeFile(".migration/cli-diagnostics.json", JSON.stringify(result, null, 2), "utf8");
console.log("wrote .migration/cli-diagnostics.json");
