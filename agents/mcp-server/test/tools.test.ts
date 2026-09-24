import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { SimulatedLedger } from "../src/core/ledger.ts";
import { AgentMemory } from "../src/core/memory.ts";
import { packBundle } from "../src/core/manifest.ts";
import { MemoryBlobStore } from "../src/core/storage.ts";
import { tools } from "../src/tools.ts";
import type { ToolContext } from "../src/tools.ts";

const call = (ctx: ToolContext, name: string, args: Record<string, unknown>) => {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.run(ctx, args as never) as Promise<any>;
};

async function build(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "sigil-build-"));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  return dir;
}

async function context() {
  const ledger = new SimulatedLedger();
  ledger.stakeSentinel("sentinel-1", 10_000);
  const ctx: ToolContext = {
    ledger,
    store: new MemoryBlobStore(),
    memory: new AgentMemory(await mkdtemp(join(tmpdir(), "sigil-mem-"))),
    profilesDir: resolve(import.meta.dirname, "../../profiles"),
  };
  const { siteId } = await call(ctx, "sigil_create_site", {
    actor: "dev", name: "dex.sui", signers: ["dev", "dao"], threshold: 2, required_reviews: 1,
  });
  return { ctx, siteId };
}

async function ship(ctx: ToolContext, siteId: string, dir: string) {
  const d = await call(ctx, "sigil_deploy", { actor: "dev", site_id: siteId, dir });
  await call(ctx, "sigil_approve", { actor: "dao", site_id: siteId, proposal: d.proposal });
  const review = await call(ctx, "sigil_review_proposal", {
    sentinel: "sentinel-1", site_id: siteId, proposal: d.proposal, attest: true, memory_namespace: "sentinel",
  });
  return { d, review };
}

test("profiles are discoverable", async () => {
  const { ctx } = await context();
  const agents = await call(ctx, "sigil_list_agents", {});
  assert.ok(agents.some((a: any) => a.role === "sentinel"));
  for (const a of agents) assert.match(a.memoryNamespace, /^[a-z0-9][a-z0-9_-]*$/);
});

test("clean build ships, injected drainer is blocked, incident rollback restores v0", async () => {
  const { ctx, siteId } = await context();

  const v0 = await build({ "index.html": "<script src='app.js'></script>", "app.js": "fetch('https://api.dex.xyz/q')" });
  const first = await ship(ctx, siteId, v0);
  assert.equal(first.review.verdict, "clean");
  assert.equal(first.review.attested, "clean");
  await call(ctx, "sigil_promote", { actor: "dev", site_id: siteId, proposal: first.d.proposal });
  assert.equal((await call(ctx, "sigil_verify_live", { site_id: siteId })).ok, true);

  // Compromised CI pushes a drainer. The Sentinel flags it and promotion aborts.
  const evil = await build({
    "index.html": "<script src='app.js'></script>",
    "app.js": "fetch('https://api.dex.xyz/q');token.approve(x, MaxUint256);fetch('https://drain.io/c')",
  });
  const bad = await ship(ctx, siteId, evil);
  assert.equal(bad.review.verdict, "block");
  assert.equal(bad.review.attested, "flag");
  assert.deepEqual(bad.review.new_origins, ["https://drain.io"]);
  await assert.rejects(call(ctx, "sigil_promote", { actor: "dev", site_id: siteId, proposal: bad.d.proposal }), /EReviewsNotMet/);

  // A benign v1 ships, then turns out bad after the fact. Incident playbook.
  const v1 = await build({ "index.html": "<script src='app.js'></script>", "app.js": "fetch('https://api.dex.xyz/q2')" });
  const second = await ship(ctx, siteId, v1);
  await call(ctx, "sigil_promote", { actor: "dev", site_id: siteId, proposal: second.d.proposal });
  const ir = await call(ctx, "sigil_incident_response", { actor: "dao", site_id: siteId, reason: "reported drain", memory_namespace: "guardian" });
  assert.deepEqual(ir, { frozen: false, rolledBackTo: 0, revoked: 1, slashEvidence: ["sentinel-1"] });
  const status = await call(ctx, "sigil_site_status", { site_id: siteId });
  assert.equal(status.liveResolved.blobId, first.d.blobId);

  const mem = await call(ctx, "sigil_recall", { namespace: "sentinel", query: "block", limit: 5 });
  assert.equal(mem.length, 1);
  assert.match(mem[0].content, /unlimited-approval/);
});

test("tampered blob is flagged on review", async () => {
  const { ctx, siteId } = await context();
  const { blobId } = await ctx.store.put(packBundle([{ path: "app.js", bytes: Buffer.from("2") }]));
  const p = await ctx.ledger.propose("dev", siteId, blobId, "0".repeat(64));
  const r = await call(ctx, "sigil_review_proposal", {
    sentinel: "sentinel-1", site_id: siteId, proposal: p, attest: true, memory_namespace: "sentinel",
  });
  assert.equal(r.reason, "manifest root mismatch");
  assert.equal(r.attested, "flag");
});
