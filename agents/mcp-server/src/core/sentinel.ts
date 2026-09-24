// Bridge to the Rust sentinel (agents/sentinel). Each scan runs as its own
// short-lived process against a private temp dir, so a hostile build
// never shares memory with the MCP server. The next step is running the
// same core as wasm32-wasip1 with no filesystem capability.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildFile } from "./manifest.ts";

export interface SentinelFinding {
  rule: string;
  severity: "info" | "review" | "high";
  file: string;
  line: number;
  excerpt: string;
  introduced: boolean;
}

export interface SentinelReport {
  verdict: "clean" | "review" | "block";
  files_scanned: number;
  findings: SentinelFinding[];
  new_origins: string[];
}

export function sentinelBinary(): string {
  if (process.env.IMMUTEX_SENTINEL_BIN) return process.env.IMMUTEX_SENTINEL_BIN;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../sentinel/target/release/immutex-sentinel");
}

async function materialize(files: BuildFile[], dir: string) {
  for (const f of files) {
    const target = resolve(dir, f.path);
    // Bundle paths are untrusted. Refuse traversal out of the scratch dir.
    if (!target.startsWith(dir + sep)) throw new Error(`refusing unsafe bundle path: ${f.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.bytes);
  }
}

export async function scanBuild(candidate: BuildFile[], baseline?: BuildFile[]): Promise<SentinelReport> {
  const bin = sentinelBinary();
  if (!existsSync(bin))
    throw new Error(`sentinel binary not found at ${bin}; run \`cargo build --release\` in agents/sentinel or set IMMUTEX_SENTINEL_BIN`);
  const work = await mkdtemp(join(tmpdir(), "immutex-scan-"));
  try {
    const cand = join(work, "candidate");
    await mkdir(cand);
    await materialize(candidate, cand);
    const args = ["scan", cand];
    if (baseline) {
      const base = join(work, "baseline");
      await mkdir(base);
      await materialize(baseline, base);
      args.push("--baseline", base);
    }
    const stdout = await new Promise<string>((ok, fail) => {
      execFile(bin, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => {
        // Exit codes 1 and 2 are verdicts, not failures.
        const code = (err as { code?: number } | null)?.code;
        if (err && code !== 1 && code !== 2) fail(new Error(`sentinel failed: ${errOut || err.message}`));
        else ok(out);
      });
    });
    return JSON.parse(stdout) as SentinelReport;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
