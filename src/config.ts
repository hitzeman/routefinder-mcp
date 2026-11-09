import path from "node:path";

import { z } from "zod";

/** Repository root, resolved from this module's compiled location in dist/src. */
export const projectRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * Cache root. Holds full-resolution GPS and must stay out of version control.
 * Override with ROUTEFINDER_CACHE_DIR, which the tests use for isolation.
 */
export const cacheDir = process.env.ROUTEFINDER_CACHE_DIR
  ? path.resolve(process.env.ROUTEFINDER_CACHE_DIR)
  : path.join(projectRoot, ".cache");

/**
 * Environment-driven settings, validated once at startup.
 *
 * Every value is bounded. Before validation existed, a malformed value silently fell
 * back to its default and a nonsensical one was accepted: a negative cell size, for
 * example, produced empty cell sets that all compare as identical and merged every run
 * into a single route. Failing fast with a message naming the variable is the fix.
 */
const envNumber = (min: number, max: number, fallback: number) =>
  z.coerce
    .number({ error: "must be a number" })
    .min(min, { error: `must be >= ${min}` })
    .max(max, { error: `must be <= ${max}` })
    .default(fallback);

const envInt = (min: number, max: number, fallback: number) =>
  envNumber(min, max, fallback).pipe(z.number().int({ error: "must be an integer" }));

const settingsEnvSchema = z.object({
  ROUTEFINDER_CELL_SIZE_M: envNumber(5, 1000, 75),
  ROUTEFINDER_SIMILARITY_THRESHOLD: envNumber(0.01, 1, 0.35),
  ROUTEFINDER_SIMPLIFY_TOLERANCE_M: envNumber(0, 1000, 10),
  ROUTEFINDER_MAX_VERTICES: envInt(2, 10_000, 400),
  ROUTEFINDER_MIN_EXTENT_RATIO: envNumber(0, 1, 0.05),
  ROUTEFINDER_INGEST_CONCURRENCY: envInt(1, 16, 4),
  ROUTEFINDER_INGEST_DEADLINE_MS: envInt(1_000, 600_000, 45_000),
  ROUTEFINDER_FETCH_TIMEOUT_MS: envInt(500, 120_000, 15_000),
});

export interface DiscoverSettings {
  cellSizeM: number;
  similarityThreshold: number;
  simplifyToleranceM: number;
  maxVertices: number;
  /**
   * Minimum spatial-extent-to-distance ratio. Below this a track is repeated laps of a
   * small circuit, not a route: a 400 m oval covered 28 times scores ~0.01, while a real
   * road loop of the same length scores 0.2 or more.
   */
  minExtentRatio: number;
}

export interface IngestSettings {
  /** Downloads in flight at once. The object host is unmetered; this is politeness. */
  concurrency: number;
  /**
   * Wall-clock budget for one ingest_activities call. The TypeScript MCP client's
   * default request timeout is 60 s; finishing inside it with a partial, resumable
   * result beats the client abandoning the whole call.
   */
  deadlineMs: number;
  /** Per-request timeout for a single download. */
  fetchTimeoutMs: number;
}

export interface Settings {
  discover: DiscoverSettings;
  ingest: IngestSettings;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid routefinder configuration:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Parse and bound every ROUTEFINDER_* tuning variable. Throws ConfigError on bad input. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  // Treat an empty string as unset, which is how shells and MCP client configs express it.
  const present = Object.fromEntries(
    Object.keys(settingsEnvSchema.shape)
      .filter((name) => env[name] !== undefined && env[name] !== "")
      .map((name) => [name, env[name]]),
  );

  const parsed = settingsEnvSchema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`),
    );
  }

  const e = parsed.data;
  return {
    discover: {
      cellSizeM: e.ROUTEFINDER_CELL_SIZE_M,
      similarityThreshold: e.ROUTEFINDER_SIMILARITY_THRESHOLD,
      simplifyToleranceM: e.ROUTEFINDER_SIMPLIFY_TOLERANCE_M,
      maxVertices: e.ROUTEFINDER_MAX_VERTICES,
      minExtentRatio: e.ROUTEFINDER_MIN_EXTENT_RATIO,
    },
    ingest: {
      concurrency: e.ROUTEFINDER_INGEST_CONCURRENCY,
      deadlineMs: e.ROUTEFINDER_INGEST_DEADLINE_MS,
      fetchTimeoutMs: e.ROUTEFINDER_FETCH_TIMEOUT_MS,
    },
  };
}
