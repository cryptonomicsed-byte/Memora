import assert from "node:assert/strict";
import { test } from "node:test";
import { Abort, MoveAbort, SimulatedLedger, liveVersion } from "../src/core/ledger.ts";

const aborts = (code: number) => (e: unknown) => e instanceof MoveAbort && e.code === code;

async function setup() {
  const l = new SimulatedLedger();
  l.stakeSentinel("s1", 10_000);
  l.stakeSentinel("s2", 10_000);
  l.stakeSentinel("poor", 1);
  const site = await l.createSite("a", "dex.sui", ["a", "b", "c"], 2, 1);
  return { l, site };
}

test("create rejects bad threshold and duplicate signers", async () => {
  const l = new SimulatedLedger();
  await assert.rejects(l.createSite("a", "x", ["a"], 2, 0), aborts(Abort.EBadConfig));
  await assert.rejects(l.createSite("a", "x", ["a", "a"], 1, 0), aborts(Abort.EBadConfig));
});

test("promotion needs threshold approvals and review quorum", async () => {
  const { l, site } = await setup();
  await assert.rejects(l.propose("mallory", site, "blob", "root"), aborts(Abort.ENotSigner));
  const p = await l.propose("a", site, "blob", "root");
  await assert.rejects(l.approve("a", site, p), aborts(Abort.EAlreadyApproved));
  await assert.rejects(l.promote("a", site, p), aborts(Abort.EThresholdNotMet));
  await l.approve("b", site, p);
  await assert.rejects(l.promote("a", site, p), aborts(Abort.EReviewsNotMet));
  await assert.rejects(l.attest("poor", site, p, true), aborts(Abort.ENotSentinel));
  await l.attest("s1", site, p, true);
  await assert.rejects(l.attest("s1", site, p, false), aborts(Abort.EAlreadyAttested));
  assert.equal(await l.promote("c", site, p), 0);
  assert.equal(liveVersion(await l.getSite(site))?.blobId, "blob");
});

test("each flag raises the clean-review bar by one", async () => {
  const { l, site } = await setup();
  const p = await l.propose("a", site, "blob", "root");
  await l.approve("b", site, p);
  await l.attest("s1", site, p, false);
  l.stakeSentinel("s3", 10_000);
  await l.attest("s2", site, p, true);
  await assert.rejects(l.promote("a", site, p), aborts(Abort.EReviewsNotMet));
  await l.attest("s3", site, p, true);
  await l.promote("a", site, p);
});

test("single-signer rollback, freeze, revoke", async () => {
  const { l, site } = await setup();
  for (const blob of ["v0", "v1"]) {
    const p = await l.propose("a", site, blob, blob);
    await l.approve("b", site, p);
    await l.attest("s1", site, p, true);
    await l.promote("a", site, p);
  }
  await assert.rejects(l.revoke("a", site, 1), aborts(Abort.ECannotRevokeLive));
  await l.freeze("c", site);
  assert.equal(liveVersion(await l.getSite(site)), undefined);
  await assert.rejects(l.propose("a", site, "x", "x"), aborts(Abort.EFrozen));
  await l.rollback("c", site, 0);
  await l.revoke("c", site, 1);
  await assert.rejects(l.rollback("a", site, 1), aborts(Abort.ERevoked));
  await assert.rejects(l.rollback("a", site, 9), aborts(Abort.ENoSuchVersion));
  const s = await l.getSite(site);
  assert.equal(liveVersion(s)?.blobId, "v0");
  const revoked = (await l.events(site)).find((e) => e.type === "Revoked");
  assert.deepEqual(revoked?.attesters, ["s1"]);
});
