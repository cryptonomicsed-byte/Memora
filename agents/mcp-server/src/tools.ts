// The Sigil tool surface. Every launchpad capability is a named, schema'd
// tool that any MCP client (a Deployer agent, a Sentinel swarm, a DAO bot,
// or a human's IDE) can discover and chain. No capability is UI-only.

import { z } from "zod";
import type { AgentMemory } from "./core/memory.ts";
import { manifestOf, packBundle, readBuild, unpackBundle } from "./core/manifest.ts";
import type { BuildFile } from "./core/manifest.ts";
import { liveVersion } from "./core/ledger.ts";
import type { Site, SiteLedger } from "./core/ledger.ts";
import { loadProfiles } from "./core/profiles.ts";
import { scanBuild } from "./core/sentinel.ts";
import type { SentinelReport } from "./core/sentinel.ts";
import type { BlobStore } from "./core/storage.ts";

export interface ToolContext {
  ledger: SiteLedger;
  store: BlobStore;
  memory: AgentMemory;
  profilesDir: string;
  scan?: (candidate: BuildFile[], baseline?: BuildFile[]) => Promise<SentinelReport>;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: S;
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

const tool = <S extends z.ZodRawShape>(t: ToolDef<S>) => t as unknown as ToolDef;

const actor = z.string().describe("Address of the signer executing this action (the agent's wallet)");
const siteId = z.string().describe("On-chain Site object ID");
const proposal = z.number().int().nonnegative().describe("Proposal number on the Site");

async function fetchBuild(ctx: ToolContext, blobId: string) {
  return unpackBundle(await ctx.store.get(blobId));
}

// Most recent non-revoked version before the live one: the default rollback target.
function lastKnownGood(site: Site): number | undefined {
  for (let i = site.live - 1; i >= 0; i--) if (!site.versions[i].revoked) return i;
  return undefined;
}

export const tools: ToolDef[] = [
  tool({
    name: "sigil_list_agents",
    description:
      "Discover the agent roles operating this launchpad (profiles with goals, skills, memory namespace, sandbox). Re-read from disk on every call.",
    input: {},
    run: async (ctx) => loadProfiles(ctx.profilesDir),
  }),

  tool({
    name: "sigil_build_manifest",
    description: "Content-address a local static build directory. Returns the manifest root that gets pinned on-chain.",
    input: { dir: z.string().describe("Path to the static build output, e.g. ./dist") },
    run: async (_ctx, { dir }) => manifestOf(await readBuild(dir)),
  }),

  tool({
    name: "sigil_deploy",
    description:
      "Upload a build to decentralized storage and open a promotion proposal on the Site. The build does NOT go live until signer threshold and Sentinel review quorum are met.",
    input: { actor, site_id: siteId, dir: z.string() },
    run: async (ctx, { actor, site_id, dir }) => {
      const files = await readBuild(dir);
      if (files.length === 0) throw new Error(`no files in ${dir}`);
      const manifest = manifestOf(files);
      const { blobId } = await ctx.store.put(packBundle(files));
      const id = await ctx.ledger.propose(actor, site_id, blobId, manifest.root);
      return { proposal: id, blobId, manifestRoot: manifest.root, files: manifest.files.length, storage: ctx.store.scheme };
    },
  }),

  tool({
    name: "sigil_create_site",
    description: "Create a Site object governed by an M-of-N signer set plus a required number of Sentinel reviews.",
    input: {
      actor,
      name: z.string(),
      signers: z.array(z.string()).min(1),
      threshold: z.number().int().positive(),
      required_reviews: z.number().int().nonnegative(),
    },
    run: async (ctx, a) => ({ siteId: await ctx.ledger.createSite(a.actor, a.name, a.signers, a.threshold, a.required_reviews) }),
  }),

  tool({
    name: "sigil_approve",
    description: "Add a signer approval to a pending build proposal.",
    input: { actor, site_id: siteId, proposal },
    run: async (ctx, a) => {
      await ctx.ledger.approve(a.actor, a.site_id, a.proposal);
      return { ok: true };
    },
  }),

  tool({
    name: "sigil_review_proposal",
    description:
      "Sentinel action: fetch a proposed build, check its bytes against the proposed manifest root, scan it for drainer and injection patterns against the live build, and attest on-chain. clean -> attest clean, block -> attest flag, review -> no attestation (escalate).",
    input: {
      sentinel: z.string().describe("Staked Sentinel address"),
      site_id: siteId,
      proposal,
      attest: z.boolean().default(true),
      memory_namespace: z.string().default("sentinel"),
    },
    run: async (ctx, a) => {
      const site = await ctx.ledger.getSite(a.site_id);
      const p = site.proposals[a.proposal];
      if (!p) throw new Error(`no proposal ${a.proposal} on ${a.site_id}`);
      const cand = await fetchBuild(ctx, p.blobId);
      if (cand.manifest.root !== p.manifestRoot) {
        // The stored bytes aren't what the proposal claims. Always flag this.
        if (a.attest) await ctx.ledger.attest(a.sentinel, a.site_id, a.proposal, false);
        await ctx.memory.remember(a.memory_namespace, "manifest-mismatch", `${a.site_id}#${a.proposal} blob ${p.blobId}`, [a.site_id]);
        return { verdict: "block", reason: "manifest root mismatch", attested: a.attest ? "flag" : null };
      }
      const live = liveVersion(site);
      const base = live ? (await fetchBuild(ctx, live.blobId)).files : undefined;
      const report = await (ctx.scan ?? scanBuild)(cand.files, base);
      let attested: "clean" | "flag" | null = null;
      if (a.attest && report.verdict !== "review") {
        const clean = report.verdict === "clean";
        await ctx.ledger.attest(a.sentinel, a.site_id, a.proposal, clean);
        attested = clean ? "clean" : "flag";
      }
      await ctx.memory.remember(
        a.memory_namespace,
        "review",
        `${a.site_id}#${a.proposal} ${report.verdict}: ${report.findings.filter((f) => f.introduced).map((f) => f.rule).join(", ") || "no introduced findings"}`,
        [a.site_id, report.verdict],
      );
      return { ...report, attested };
    },
  }),

  tool({
    name: "sigil_promote",
    description: "Make an approved, reviewed proposal the live version. Aborts unless the signer threshold and review quorum are met.",
    input: { actor, site_id: siteId, proposal },
    run: async (ctx, a) => ({ liveVersion: await ctx.ledger.promote(a.actor, a.site_id, a.proposal) }),
  }),

  tool({
    name: "sigil_rollback",
    description:
      "One-transaction rollback to a previously promoted, non-revoked version. Needs only one signer. Defaults to the last known-good version before the current one.",
    input: { actor, site_id: siteId, to: z.number().int().nonnegative().optional() },
    run: async (ctx, a) => {
      const site = await ctx.ledger.getSite(a.site_id);
      const to = a.to ?? lastKnownGood(site);
      if (to === undefined) throw new Error("no earlier non-revoked version to roll back to");
      await ctx.ledger.rollback(a.actor, a.site_id, to);
      return { from: site.live, to, blobId: site.versions[to].blobId };
    },
  }),

  tool({
    name: "sigil_incident_response",
    description:
      "Playbook for a compromised live build: freeze serving, roll back to the last known-good version, revoke the bad version, and record it in memory. Returns the Sentinels who attested the bad build (slashing evidence for governance).",
    input: { actor, site_id: siteId, reason: z.string(), memory_namespace: z.string().default("guardian") },
    run: async (ctx, a) => {
      const before = await ctx.ledger.getSite(a.site_id);
      if (!before.hasLive) throw new Error("site has no live version");
      const bad = before.live;
      const good = lastKnownGood(before);
      await ctx.ledger.freeze(a.actor, a.site_id);
      if (good === undefined) {
        await ctx.memory.remember(a.memory_namespace, "incident", `${a.site_id} v${bad} frozen, no fallback: ${a.reason}`, [a.site_id]);
        return { frozen: true, rolledBackTo: null, revoked: null, slashEvidence: before.versions[bad].attesters };
      }
      await ctx.ledger.rollback(a.actor, a.site_id, good);
      await ctx.ledger.revoke(a.actor, a.site_id, bad);
      await ctx.memory.remember(a.memory_namespace, "incident", `${a.site_id} v${bad} -> v${good}: ${a.reason}`, [a.site_id]);
      return { frozen: false, rolledBackTo: good, revoked: bad, slashEvidence: before.versions[bad].attesters };
    },
  }),

  tool({
    name: "sigil_site_status",
    description: "Read a Site: signers, thresholds, live version, version history, and pending proposals with their approval and review counts.",
    input: { site_id: siteId },
    run: async (ctx, { site_id }) => {
      const s = await ctx.ledger.getSite(site_id);
      return { ...s, liveResolved: liveVersion(s) ?? null };
    },
  }),

  tool({
    name: "sigil_verify_live",
    description:
      "Portal/verifier action: fetch the live blob from storage, recompute its manifest root from the bytes, and compare it to the on-chain root. A mismatch means storage or the portal is serving tampered content.",
    input: { site_id: siteId },
    run: async (ctx, { site_id }) => {
      const s = await ctx.ledger.getSite(site_id);
      const live = liveVersion(s);
      if (!live) return { ok: false, reason: s.frozen ? "frozen" : "no live version" };
      try {
        const { manifest } = await fetchBuild(ctx, live.blobId);
        return { ok: manifest.root === live.manifestRoot, onChain: live.manifestRoot, served: manifest.root };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  }),

  tool({
    name: "sigil_events",
    description: "On-chain event log for a Site (Proposed, Attested, Promoted, RolledBack, Revoked…). Agents read it to reconstruct history.",
    input: { site_id: siteId.optional() },
    run: async (ctx, { site_id }) => ctx.ledger.events(site_id),
  }),

  tool({
    name: "sigil_remember",
    description: "Append a record to an agent's memory namespace.",
    input: { namespace: z.string(), kind: z.string(), content: z.string(), tags: z.array(z.string()).default([]) },
    run: async (ctx, a) => ctx.memory.remember(a.namespace, a.kind, a.content, a.tags),
  }),

  tool({
    name: "sigil_recall",
    description: "Search an agent's memory namespace, newest first.",
    input: {
      namespace: z.string(),
      query: z.string().optional(),
      kind: z.string().optional(),
      limit: z.number().int().positive().max(200).default(20),
    },
    run: async (ctx, a) => ctx.memory.recall(a.namespace, { query: a.query, kind: a.kind, limit: a.limit }),
  }),
];
