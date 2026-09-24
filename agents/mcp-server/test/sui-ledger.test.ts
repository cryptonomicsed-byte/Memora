import assert from "node:assert/strict";
import { test } from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { Abort, MoveAbort } from "../src/core/ledger.ts";
import { ProposalBcs, SiteBcs, SiteEvents, SuiLedger } from "../src/core/sui-ledger.ts";
import type { SuiCore } from "../src/core/sui-ledger.ts";

const PKG = normalizeSuiAddress("0xabc");
const SITE = normalizeSuiAddress("0x5173");
const TABLE = normalizeSuiAddress("0x7ab1e");
const REG = normalizeSuiAddress("0x4e9");

function harness(reply: (fn: string) => { events?: { eventType: string; bcs: Uint8Array }[]; abort?: [string, number] } = () => ({})) {
  const signer = Ed25519Keypair.generate();
  const me = signer.toSuiAddress();
  const sent: Transaction[] = [];
  const fields = new Map<number, Uint8Array>();
  let siteBytes: Uint8Array = new Uint8Array();
  const core: SuiCore = {
    async signAndExecuteTransaction({ transaction }) {
      sent.push(transaction);
      const call = transaction.getData().commands[0].MoveCall!;
      const r = reply(call.function);
      const tx = {
        digest: `d${sent.length}`,
        status: r.abort
          ? { success: false, error: { message: "abort", $kind: "MoveAbort", MoveAbort: { abortCode: String(r.abort[1]), location: { module: r.abort[0] } } } }
          : { success: true, error: null },
        events: r.events ?? [],
      };
      return r.abort ? { $kind: "FailedTransaction", FailedTransaction: tx } : { $kind: "Transaction", Transaction: tx };
    },
    async waitForTransaction() {},
    async getObject() {
      return { object: { content: siteBytes } };
    },
    async getDynamicField({ parentId, name }) {
      assert.equal(parentId, TABLE);
      const b = fields.get(Number(bcs.u64().parse(name.bcs)));
      if (!b) throw new Error("not found");
      return { dynamicField: { value: { bcs: b } } };
    },
    async listEvents() {
      return { events: [] };
    },
  };
  const ledger = new SuiLedger({ packageId: PKG, registryId: REG, signer, core });
  return { ledger, me, sent, fields, setSite: (b: Uint8Array) => (siteBytes = b) };
}

const ev = (name: keyof typeof SiteEvents, data: any) => ({
  eventType: `${PKG}::site::${name}`,
  bcs: (SiteEvents[name] as any).serialize(data).toBytes(),
});

test("propose builds a site::propose call and returns the id from the Proposed event", async () => {
  const h = harness(() => ({
    events: [ev("Proposed", { site: SITE, proposal: 7, blob_id: "blob", manifest_root: [0xab, 0xcd], proposer: SITE })],
  }));
  const id = await h.ledger.propose(h.me, SITE, "blob", "abcd");
  assert.equal(id, 7);
  const data = h.sent[0].getData();
  const call = data.commands[0].MoveCall!;
  assert.deepEqual([normalizeSuiAddress(call.package), call.module, call.function], [PKG, "site", "propose"]);
  assert.equal(call.arguments.length, 4); // site, blob_id, manifest_root, clock
});

test("attest passes the registry object", async () => {
  const h = harness();
  await h.ledger.attest(h.me, SITE, 1, true);
  const data = h.sent[0].getData();
  const objectIds = data.inputs.map((i: any) => i.UnresolvedObject?.objectId).filter(Boolean).map((x: string) => normalizeSuiAddress(x));
  assert.deepEqual(objectIds, [SITE, REG]);
});

test("refuses to sign as a different address", async () => {
  const h = harness();
  await assert.rejects(h.ledger.freeze("0x1", SITE), /cannot act as/);
  assert.equal(h.sent.length, 0);
});

test("site aborts map to MoveAbort, other module aborts do not", async () => {
  const h = harness((fn) => (fn === "promote" ? { abort: ["site", Abort.EReviewsNotMet] } : { abort: ["sentinel_registry", 1] }));
  await assert.rejects(h.ledger.promote(h.me, SITE, 0), (e: unknown) => e instanceof MoveAbort && e.code === Abort.EReviewsNotMet);
  await assert.rejects(h.ledger.rollback(h.me, SITE, 0), (e: unknown) => !(e instanceof MoveAbort));
});

test("getSite decodes the Site and pending proposals, skipping promoted slots", async () => {
  const h = harness();
  const signer = normalizeSuiAddress("0x51");
  h.setSite(
    SiteBcs.serialize({
      id: SITE,
      name: "dex.sui",
      signers: { contents: [signer] },
      threshold: 1,
      required_reviews: 1,
      versions: [{ blob_id: "b0", manifest_root: [1, 2], promoted_ms: 5, attesters: [signer], revoked: false }],
      live: 0,
      has_live: true,
      frozen: false,
      proposals: { id: TABLE, size: 1 },
      next_proposal: 2,
    }).toBytes(),
  );
  h.fields.set(
    1,
    ProposalBcs.serialize({
      blob_id: "b1",
      manifest_root: [0xff],
      proposer: signer,
      approvals: { contents: [signer] },
      clean: { contents: [] },
      flagged: { contents: [] },
      created_ms: 9,
    }).toBytes(),
  );
  const s = await h.ledger.getSite(SITE);
  assert.equal(s.name, "dex.sui");
  assert.equal(s.versions[0].manifestRoot, "0102");
  assert.deepEqual(Object.keys(s.proposals), ["1"]);
  assert.equal(s.proposals[1].manifestRoot, "ff");
  assert.deepEqual(s.proposals[1].approvals, [signer]);
});
