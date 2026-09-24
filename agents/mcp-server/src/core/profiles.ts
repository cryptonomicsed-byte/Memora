// Agent profiles live in agents/profiles/*.json and are hot-reloaded on
// every discovery call. Dropping in a new profile registers a new agent
// role without restarting the server.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentProfile {
  id: string;
  role: string;
  goals: string[];
  preferences: Record<string, unknown>;
  skills: string[];
  memoryNamespace: string;
  sandbox: { kind: string; capabilities: string[] };
}

export async function loadProfiles(dir: string): Promise<AgentProfile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), "utf8")) as AgentProfile));
}
