// Pluggable decentralized storage. Walrus is the reference adapter; Arweave
// and Shadow Drive adapters implement the same two-method interface and
// register under their own scheme.

import { createHash } from "node:crypto";

export interface BlobStore {
  readonly scheme: string;
  put(bytes: Buffer): Promise<{ blobId: string }>;
  get(blobId: string): Promise<Buffer>;
}

export class MemoryBlobStore implements BlobStore {
  readonly scheme = "memory";
  private blobs = new Map<string, Buffer>();
  async put(bytes: Buffer) {
    const blobId = createHash("sha256").update(bytes).digest("base64url");
    this.blobs.set(blobId, Buffer.from(bytes));
    return { blobId };
  }
  async get(blobId: string) {
    const b = this.blobs.get(blobId);
    if (!b) throw new Error(`blob not found: ${blobId}`);
    return Buffer.from(b);
  }
}

export interface WalrusConfig {
  publisherUrl: string;
  aggregatorUrl: string;
  epochs: number;
  fetch?: typeof fetch;
}

// Talks to the Walrus HTTP publisher/aggregator API:
//   PUT {publisher}/v1/blobs?epochs=N   -> newlyCreated | alreadyCertified
//   GET {aggregator}/v1/blobs/{blobId}
export class WalrusBlobStore implements BlobStore {
  readonly scheme = "walrus";
  private cfg: WalrusConfig;
  constructor(cfg: WalrusConfig) {
    this.cfg = cfg;
  }

  async put(bytes: Buffer) {
    const f = this.cfg.fetch ?? fetch;
    const res = await f(`${this.cfg.publisherUrl}/v1/blobs?epochs=${this.cfg.epochs}`, {
      method: "PUT",
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new Error(`walrus publisher ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      newlyCreated?: { blobObject: { blobId: string } };
      alreadyCertified?: { blobId: string };
    };
    const blobId = body.newlyCreated?.blobObject.blobId ?? body.alreadyCertified?.blobId;
    if (!blobId) throw new Error(`unexpected walrus response: ${JSON.stringify(body)}`);
    return { blobId };
  }

  async get(blobId: string) {
    const f = this.cfg.fetch ?? fetch;
    const res = await f(`${this.cfg.aggregatorUrl}/v1/blobs/${encodeURIComponent(blobId)}`);
    if (!res.ok) throw new Error(`walrus aggregator ${res.status} for ${blobId}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// Local content-addressed store for offline development. Survives restarts.
export class FsBlobStore implements BlobStore {
  readonly scheme = "fs";
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  async put(bytes: Buffer) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const blobId = createHash("sha256").update(bytes).digest("base64url");
    await mkdir(this.dir, { recursive: true });
    await writeFile(`${this.dir}/${blobId}`, bytes);
    return { blobId };
  }
  async get(blobId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(blobId)) throw new Error(`invalid blob id: ${blobId}`);
    const { readFile } = await import("node:fs/promises");
    return readFile(`${this.dir}/${blobId}`);
  }
}
