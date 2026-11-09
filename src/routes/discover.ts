import type { CachedTrack } from "../cache/store.js";
import type { TrackPoint } from "../fit/decode.js";
import { cellsFor, gridAnchorFor, jaccard } from "./cells.js";
import { clusterByThreshold } from "./cluster.js";
import { boundingBox, extentM, MILES_TO_METRES } from "./geo.js";
import { simplifyToBudget } from "./simplify.js";
import { loadSettings, type DiscoverSettings } from "../config.js";

export type { DiscoverSettings };

/**
 * Defaults measured against the golden-set corpus of 30 real runs in the 7-mile band,
 * not guessed.
 *
 * At a 75 m cell, the 435 pairwise similarities are sharply bimodal: 269 fall below 0.2,
 * 142 sit above 0.7, and only 24 land anywhere in between. The 0.3-0.4 band contains
 * *zero* pairs, so a threshold of 0.35 sits in a literal empty gap - every threshold in
 * that gap produces identical grouping, which is as insensitive as a tuning parameter
 * can get.
 *
 * Margins either side: grouping is unchanged from 0.30 to 0.40, and all 30 runs collapse
 * into one route only at 0.15 or below, so 0.35 keeps better than a 2x margin above
 * failure. A 100 m cell collapses at 0.20, which is why the cell stays at 75 m.
 */
export function defaultSettings(env: NodeJS.ProcessEnv = process.env): DiscoverSettings {
  return loadSettings(env).discover;
}

export interface Route {
  /** Stable within a result: derived from the representative track's cache key. */
  id: string;
  /** Human-facing label assigned by result order: "Route A", "Route B", ... */
  label: string;
  distanceMiles: number;
  distanceM: number;
  runCount: number;
  lastRunDate: string;
  firstRunDate: string;
  /** Simplified geometry of the representative (medoid) run. */
  geometry: TrackPoint[];
}

export interface ExcludedTrack {
  key: string;
  reason: string;
}

export type DiscoverState = "ok" | "empty-cache" | "no-match";

export interface DiscoverResult {
  state: DiscoverState;
  routes: Route[];
  /** Tracks that passed the distance filter and were eligible for grouping. */
  consideredCount: number;
  /** Total tracks in the cache, regardless of distance. */
  cachedCount: number;
  excluded: ExcludedTrack[];
  settings: DiscoverSettings;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : ((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/**
 * Group cached tracks of a target distance into distinct routes.
 *
 * Pure: it reads the tracks it is given and issues no network request of any kind.
 */
export function discoverRoutes(
  tracks: readonly CachedTrack[],
  targetMiles: number,
  toleranceMiles: number,
  overrides: Partial<DiscoverSettings> = {},
): DiscoverResult {
  const settings = { ...defaultSettings(), ...overrides };

  if (tracks.length === 0) {
    return {
      state: "empty-cache",
      routes: [],
      consideredCount: 0,
      cachedCount: 0,
      excluded: [],
      settings,
    };
  }

  const targetM = targetMiles * MILES_TO_METRES;
  const toleranceM = toleranceMiles * MILES_TO_METRES;

  const excluded: ExcludedTrack[] = [];
  const candidates: CachedTrack[] = [];

  // Sorted by key so the candidate order never depends on cache iteration order.
  const ordered = [...tracks].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  for (const track of ordered) {
    // Epsilon, not cosmetic: mile-to-metre conversion makes an exactly-on-the-boundary
    // distance land a fraction of a micrometre outside the tolerance, which would
    // exclude a track the spec says must be considered.
    if (Math.abs(track.totalDistanceM - targetM) > toleranceM + 1e-6) continue;

    const extent = extentM(track.points);
    const ratio = track.totalDistanceM > 0 ? extent / track.totalDistanceM : 0;
    if (ratio < settings.minExtentRatio) {
      excluded.push({
        key: track.key,
        reason:
          `spatial extent ${Math.round(extent)} m over ${Math.round(track.totalDistanceM)} m ` +
          `of distance (ratio ${ratio.toFixed(3)}) is below the ${settings.minExtentRatio} ` +
          `minimum: repeated laps of a small circuit, not a route`,
      });
      continue;
    }

    candidates.push(track);
  }

  if (candidates.length === 0) {
    return {
      state: "no-match",
      routes: [],
      consideredCount: 0,
      cachedCount: tracks.length,
      excluded,
      settings,
    };
  }

  // One grid anchor for the whole candidate set, derived order-independently from the
  // bounding box of every candidate. All tracks must be quantized on the same grid or
  // their cell sets are not comparable.
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const track of candidates) {
    const box = boundingBox(track.points);
    if (box.minLat < minLat) minLat = box.minLat;
    if (box.maxLat > maxLat) maxLat = box.maxLat;
    if (box.minLon < minLon) minLon = box.minLon;
    if (box.maxLon > maxLon) maxLon = box.maxLon;
  }
  const anchor = gridAnchorFor((minLat + maxLat) / 2, (minLon + maxLon) / 2);

  const cellSets = candidates.map((track) =>
    cellsFor(track.points, settings.cellSizeM, anchor),
  );

  // Memoised symmetric similarity, so clustering and medoid selection share the work.
  const cache = new Map<string, number>();
  const similarity = (i: number, j: number): number => {
    if (i === j) return 1;
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const value = jaccard(cellSets[i]!, cellSets[j]!);
    cache.set(key, value);
    return value;
  };

  const groups = clusterByThreshold(
    candidates.length,
    similarity,
    settings.similarityThreshold,
  );

  const routes: Route[] = groups.map((group) => {
    // Medoid: highest mean similarity to the rest of its group. Deterministic, and the
    // most typical shape in the group - unlike "most recent", where one bad GPS day
    // would become the canonical geometry.
    let medoidIndex = group[0]!;
    let bestScore = -Infinity;
    for (const member of group) {
      let total = 0;
      for (const other of group) {
        if (other !== member) total += similarity(member, other);
      }
      const score = group.length > 1 ? total / (group.length - 1) : 1;
      const incumbent = candidates[medoidIndex]!;
      const challenger = candidates[member]!;
      if (
        score > bestScore ||
        // Tie-break on key so the medoid cannot depend on group order.
        (score === bestScore && challenger.key < incumbent.key)
      ) {
        bestScore = score;
        medoidIndex = member;
      }
    }

    const members = group.map((index) => candidates[index]!);
    const distances = members.map((track) => track.totalDistanceM);
    const dates = members.map((track) => track.startTime).sort();
    const medoid = candidates[medoidIndex]!;

    const { points } = simplifyToBudget(
      medoid.points,
      settings.simplifyToleranceM,
      settings.maxVertices,
    );

    const distanceM = median(distances);

    return {
      id: medoid.key.slice(0, 12),
      label: "",
      distanceMiles: Number((distanceM / MILES_TO_METRES).toFixed(2)),
      distanceM: Number(distanceM.toFixed(1)),
      runCount: members.length,
      firstRunDate: dates[0]!,
      lastRunDate: dates[dates.length - 1]!,
      geometry: points,
    };
  });

  // Most-run first, then longest, then by id. Fully specified so repeated runs match.
  routes.sort(
    (a, b) =>
      b.runCount - a.runCount ||
      b.distanceM - a.distanceM ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  routes.forEach((route, index) => {
    route.label = `Route ${String.fromCharCode(65 + (index % 26))}`;
  });

  return {
    state: "ok",
    routes,
    consideredCount: candidates.length,
    cachedCount: tracks.length,
    excluded,
    settings,
  };
}
