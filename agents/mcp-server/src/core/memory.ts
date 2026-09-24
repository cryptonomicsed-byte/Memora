// Per-agent episodic memory. Each agent profile owns one namespace, stored
// as an append-only JSONL file. Agents record outcomes (a scan verdict, a
// rollback, a false positive) and recall them before planning. That's the
// reflection loop that lets a Sentinel get better at its job over time.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface MemoryRecord {
  ts: string;
  kind: string;
  content: string;
  tags: string[];
}

const NS = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class AgentMemory {
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private file(ns: string) {
    if (!NS.test(ns)) throw new Error(`invalid memory namespace: ${ns}`);
    return join(this.dir, `${ns}.jsonl`);
  }

  async remember(ns: string, kind: string, content: string, tags: string[] = []): Promise<MemoryRecord> {
    const rec: MemoryRecord = { ts: new Date().toISOString(), kind, content, tags };
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(ns), JSON.stringify(rec) + "\n");
    return rec;
  }

  async recall(ns: string, opts: { query?: string; kind?: string; limit?: number } = {}): Promise<MemoryRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(ns), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const q = opts.query?.toLowerCase();
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as MemoryRecord)
      .filter((r) => (!opts.kind || r.kind === opts.kind))
      .filter((r) => !q || r.content.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)))
      .slice(-(opts.limit ?? 20))
      .reverse();
  }
}
