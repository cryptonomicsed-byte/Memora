#!/usr/bin/env node
// Memora MCP server (stdio). Wires the tool surface to a ledger and a blob store.
//
//   MEMORA_HOME        state dir (default ./.memora): ledger snapshot, blobs, agent memory
//   MEMORA_STORAGE     "fs" (default) | "walrus"
//   WALRUS_PUBLISHER   e.g. https://publisher.walrus-testnet.walrus.space
//   WALRUS_AGGREGATOR  e.g. https://aggregator.walrus-testnet.walrus.space
//   WALRUS_EPOCHS      storage epochs per upload (default 5)
//   MEMORA_LEDGER      "sim" (default) | "sui"
//   SUI_NETWORK        testnet (default) | mainnet | devnet
//   SUI_GRPC_URL       fullnode gRPC URL (default https://fullnode.<network>.sui.io)
//   MEMORA_PACKAGE_ID  published memora package ID          (sui ledger)
//   MEMORA_REGISTRY_ID shared sentinel_registry::Registry   (sui ledger)
//   SUI_PRIVATE_KEY    suiprivkey1… for the agent's signer   (sui ledger)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SimulatedLedger } from "./core/ledger.ts";
import type { LedgerState, SiteLedger } from "./core/ledger.ts";
import { SuiLedger } from "./core/sui-ledger.ts";
import type { SuiCore } from "./core/sui-ledger.ts";
import { AgentMemory } from "./core/memory.ts";
import { FsBlobStore, WalrusBlobStore } from "./core/storage.ts";
import type { BlobStore } from "./core/storage.ts";
import { tools } from "./tools.ts";
import type { ToolContext } from "./tools.ts";

const home = resolve(process.env.MEMORA_HOME ?? ".memora");
mkdirSync(home, { recursive: true });
const statePath = join(home, "ledger.json");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required when MEMORA_LEDGER=sui`);
  return v;
}

async function suiLedger(): Promise<SuiLedger> {
  const { SuiGrpcClient } = await import("@mysten/sui/grpc");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const network = (process.env.SUI_NETWORK ?? "testnet") as "testnet" | "mainnet" | "devnet";
  const client = new SuiGrpcClient({ network, baseUrl: process.env.SUI_GRPC_URL ?? `https://fullnode.${network}.sui.io:443` });
  return new SuiLedger({
    packageId: requireEnv("MEMORA_PACKAGE_ID"),
    registryId: requireEnv("MEMORA_REGISTRY_ID"),
    signer: Ed25519Keypair.fromSecretKey(requireEnv("SUI_PRIVATE_KEY")),
    core: client.core as unknown as SuiCore,
  });
}

const simulated =
  process.env.MEMORA_LEDGER === "sui"
    ? undefined
    : new SimulatedLedger(
        existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as LedgerState) : undefined,
        Date.now,
        (s) => writeFileSync(statePath, JSON.stringify(s)),
      );
const ledger: SiteLedger = simulated ?? (await suiLedger());

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
if (simulated) server.registerTool(
  "memora_sim_stake_sentinel",
  {
    description: "SIMULATED LEDGER ONLY: bond a Sentinel address so it can attest. On Sui, call sentinel_registry::stake with MEMO instead.",
    inputSchema: { sentinel: z.string(), amount: z.number().int().positive() },
  },
  async ({ sentinel, amount }) => {
    simulated.stakeSentinel(sentinel, amount);
    return asResult({ ok: true });
  },
);

await server.connect(new StdioServerTransport());
