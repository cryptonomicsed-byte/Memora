#!/usr/bin/env node
// Memora MCP server (stdio). Wires the tool surface to a ledger and a blob store.
//
//   MEMORA_HOME        state dir (default ./.memora): ledger snapshot, blobs, agent memory
//   MEMORA_STORAGE     "fs" (default) | "walrus"
//   WALRUS_PUBLISHER   e.g. https://publisher.walrus-testnet.walrus.space
//   WALRUS_AGGREGATOR  e.g. https://aggregator.walrus-testnet.walrus.space
//   WALRUS_EPOCHS      storage epochs per upload (default 5)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SimulatedLedger } from "./core/ledger.ts";
import type { LedgerState } from "./core/ledger.ts";
import { AgentMemory } from "./core/memory.ts";
import { FsBlobStore, WalrusBlobStore } from "./core/storage.ts";
import type { BlobStore } from "./core/storage.ts";
import { tools } from "./tools.ts";
import type { ToolContext } from "./tools.ts";

const home = resolve(process.env.MEMORA_HOME ?? ".memora");
mkdirSync(home, { recursive: true });
const statePath = join(home, "ledger.json");

const ledger = new SimulatedLedger(
  existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as LedgerState) : undefined,
  Date.now,
  (s) => writeFileSync(statePath, JSON.stringify(s)),
);

const store: BlobStore =
  process.env.MEMORA_STORAGE === "walrus"
    ? new WalrusBlobStore({
        publisherUrl: process.env.WALRUS_PUBLISHER ?? "https://publisher.walrus-testnet.walrus.space",
        aggregatorUrl: process.env.WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space",
        epochs: Number(process.env.WALRUS_EPOCHS ?? 5),
      })
    : new FsBlobStore(join(home, "blobs"));

const ctx: ToolContext = {
  ledger,
  store,
  memory: new AgentMemory(join(home, "memory")),
  profilesDir: resolve(dirname(fileURLToPath(import.meta.url)), "../../profiles"),
};

const server = new McpServer({ name: "memora", version: "0.1.0" });

const asResult = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const asError = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });

for (const t of tools) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args: unknown) => {
    try {
      return asResult(await t.run(ctx, args as never));
    } catch (e) {
      return asError(e);
    }
  });
}

// Simulation-only: bond a Sentinel. On Sui this is sentinel_registry::stake.
server.registerTool(
  "memora_sim_stake_sentinel",
  {
    description: "SIMULATED LEDGER ONLY: bond a Sentinel address so it can attest. On Sui, call sentinel_registry::stake with MEMO instead.",
    inputSchema: { sentinel: z.string(), amount: z.number().int().positive() },
  },
  async ({ sentinel, amount }) => {
    ledger.stakeSentinel(sentinel, amount);
    return asResult({ ok: true });
  },
);

await server.connect(new StdioServerTransport());
