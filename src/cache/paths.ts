import fs from "node:fs/promises";
import path from "node:path";

import { cacheDir } from "../config.js";

/**
 * Tier 1: raw activity file bytes exactly as fetched.
 *
 * This tier exists to protect the metered COROS quota: bytes land here before any
 * parsing is attempted, so a parser failure costs nothing to retry. Never re-fetched
 * once populated.
 */
export const rawDir = (root: string = cacheDir): string => path.join(root, "raw");

/**
 * Tier 2: parsed tracks, freely rebuildable from tier 1.
 */
export const tracksDir = (root: string = cacheDir): string =>
  path.join(root, "tracks");

/** Create both cache tiers if they do not already exist. */
export async function ensureCacheLayout(root: string = cacheDir): Promise<void> {
  await fs.mkdir(rawDir(root), { recursive: true });
  await fs.mkdir(tracksDir(root), { recursive: true });
}
