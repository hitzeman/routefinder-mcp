import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { cacheDir } from "../config.js";
import { decodeActivity, type Track } from "../fit/decode.js";
import { ensureCacheLayout, rawDir, tracksDir } from "./paths.js";

/**
 * Cache key for an activity.
 *
 * A SHA-256 of the URL rather than the URL itself: the URL is an unrevocable bearer
 * secret and must not be persisted. The digest is still a stable identity, because a
 * COROS activity URL is content-addressed - its filename carries a digest of the file's
 * own bytes - so the same activity always yields the same key.
 */
export function cacheKey(url: string): string {
  return crypto.createHash("sha256").update(url, "utf8").digest("hex");
}

export interface CachedTrack extends Track {
  /** The key this track is stored under. Never the URL. */
  key: string;
}

export class ActivityCache {
  readonly root: string;

  constructor(root: string = cacheDir) {
    this.root = root;
  }

  async init(): Promise<void> {
    await ensureCacheLayout(this.root);
  }

  private rawPath(key: string): string {
    return path.join(rawDir(this.root), `${key}.fit`);
  }

  private trackPath(key: string): string {
    return path.join(tracksDir(this.root), `${key}.json`);
  }

  async hasRaw(key: string): Promise<boolean> {
    return fs
      .access(this.rawPath(key))
      .then(() => true)
      .catch(() => false);
  }

  async hasTrack(key: string): Promise<boolean> {
    return fs
      .access(this.trackPath(key))
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Persist raw bytes. Called before any parse is attempted, so that a parser failure
   * never costs another metered request to recover from.
   */
  async putRaw(key: string, bytes: Buffer): Promise<void> {
    await this.init();
    await fs.writeFile(this.rawPath(key), bytes);
  }

  async getRaw(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.rawPath(key));
    } catch {
      return null;
    }
  }

  async putTrack(track: CachedTrack): Promise<void> {
    await this.init();
    await fs.writeFile(this.trackPath(track.key), JSON.stringify(track));
  }

  async getTrack(key: string): Promise<CachedTrack | null> {
    try {
      const raw = await fs.readFile(this.trackPath(key), "utf8");
      return JSON.parse(raw) as CachedTrack;
    } catch {
      return null;
    }
  }

  /**
   * Parse an activity from the raw tier into the track tier.
   *
   * This is the operation that makes the second tier disposable: it needs nothing but
   * bytes already on disk, so re-parsing the whole corpus issues no requests.
   */
  async parseFromRaw(
    key: string,
  ): Promise<{ ok: true; track: CachedTrack } | { ok: false; reason: string }> {
    const bytes = await this.getRaw(key);
    if (bytes === null) {
      return { ok: false, reason: "activity is not in the raw cache" };
    }

    const outcome = decodeActivity(bytes);
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }

    const track: CachedTrack = { ...outcome.track, key };
    await this.putTrack(track);
    return { ok: true, track };
  }

  /** Every cached track, ordered by key so iteration is deterministic. */
  async allTracks(): Promise<CachedTrack[]> {
    await this.init();
    const entries = await fs.readdir(tracksDir(this.root));
    const keys = entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();

    const tracks: CachedTrack[] = [];
    for (const key of keys) {
      const track = await this.getTrack(key);
      if (track !== null) tracks.push(track);
    }
    return tracks;
  }

  /** Keys present in the raw tier, sorted. */
  async rawKeys(): Promise<string[]> {
    await this.init();
    const entries = await fs.readdir(rawDir(this.root));
    return entries
      .filter((name) => name.endsWith(".fit"))
      .map((name) => name.slice(0, -".fit".length))
      .sort();
  }
}
