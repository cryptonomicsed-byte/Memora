// Content addressing for static builds. The manifest root is what goes
// on-chain (Site.versions[i].manifest_root). Portals and verifier agents
// recompute it from the served bytes and refuse anything that doesn't match.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface BuildManifest {
  root: string;
  files: ManifestEntry[];
}

export interface BuildFile {
  path: string;
  bytes: Buffer;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export async function readBuild(dir: string): Promise<BuildFile[]> {
  const out: BuildFile[] = [];
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the build
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push({ path: relative(dir, p).split(sep).join("/"), bytes: await readFile(p) });
    }
  }
  await walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function manifestOf(files: BuildFile[]): BuildManifest {
  const entries = files
    .map((f) => ({ path: f.path, sha256: sha256(f.bytes), size: f.bytes.length }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const root = sha256(entries.map((e) => `${e.path}\0${e.sha256}\n`).join(""));
  return { root, files: entries };
}

// A build is stored as one deterministic bundle blob: the manifest plus every
// file, base64-encoded. Deterministic serialization means the same build
// always yields the same blob ID, so re-uploads dedupe.
export function packBundle(files: BuildFile[]): Buffer {
  const manifest = manifestOf(files);
  const body = {
    format: "memora-bundle/1",
    manifest,
    files: files.map((f) => ({ path: f.path, data: f.bytes.toString("base64") })),
  };
  return Buffer.from(JSON.stringify(body));
}

export function unpackBundle(bytes: Buffer): { manifest: BuildManifest; files: BuildFile[] } {
  const body = JSON.parse(bytes.toString("utf8"));
  if (body.format !== "memora-bundle/1") throw new Error(`unknown bundle format: ${body.format}`);
  const files: BuildFile[] = body.files.map((f: { path: string; data: string }) => ({
    path: f.path,
    bytes: Buffer.from(f.data, "base64"),
  }));
  // Never trust the embedded manifest: recompute from the bytes.
  const manifest = manifestOf(files);
  if (manifest.root !== body.manifest.root) throw new Error("bundle manifest does not match its contents");
  return { manifest, files };
}
