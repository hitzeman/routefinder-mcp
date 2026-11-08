import type { TrackPoint } from "../fit/decode.js";
import { METRES_PER_DEGREE_LAT, metresPerDegreeLon } from "./geo.js";

/**
 * Reduce a track to the set of grid cells it occupies.
 *
 * The decisive property is that this is a *set*: it has no order, so the direction a
 * route was travelled disappears. A loop run clockwise and the same loop run
 * anticlockwise occupy exactly the same cells and therefore compare as identical. The
 * reversal problem is dissolved rather than special-cased.
 *
 * Longitude is scaled by cos(latitude) so cells are roughly square on the ground;
 * otherwise east-west cells would be ~19% wider at this latitude and the metric would
 * favour one axis.
 *
 * Interpolation matters: at 1 Hz a runner covers ~2.8 m, but a cyclist or a GPS gap can
 * jump much further, and an un-interpolated jump would leave holes in the cell set that
 * look like a different route.
 */
export interface GridAnchor {
  lat: number;
  lon: number;
}

/**
 * A grid anchor shared by every track in a comparison.
 *
 * Two properties matter, and getting either wrong silently corrupts the metric:
 *
 * 1. **Order independence.** Deriving the longitude scale from `points[0]` makes it
 *    change when a track is reversed, which breaks the direction invariance this whole
 *    approach is built on.
 * 2. **A shared origin.** Indexing on raw `lon * metresPerDegree` produces magnitudes
 *    around 9,000,000 m, so a 0.001 degree difference in reference latitude shifts the
 *    grid by ~100 m - more than one cell. Tracks would be compared on misaligned grids.
 *
 * Rounding to a half-degree keeps the anchor stable as the corpus changes, so grouping
 * does not shift when one activity is added.
 */
export function gridAnchorFor(latitude: number, longitude: number): GridAnchor {
  return {
    lat: Math.round(latitude * 2) / 2,
    lon: Math.round(longitude * 2) / 2,
  };
}

export function cellsFor(
  points: readonly TrackPoint[],
  cellSizeM: number,
  anchor: GridAnchor,
): Set<string> {
  const cells = new Set<string>();
  if (points.length === 0 || cellSizeM <= 0) return cells;

  const lonScale = metresPerDegreeLon(anchor.lat);

  const toCell = (point: TrackPoint): string => {
    const x = Math.floor(((point.lon - anchor.lon) * lonScale) / cellSizeM);
    const y = Math.floor(
      ((point.lat - anchor.lat) * METRES_PER_DEGREE_LAT) / cellSizeM,
    );
    return `${x}:${y}`;
  };

  let previous: TrackPoint | undefined;
  for (const point of points) {
    if (previous !== undefined) {
      const dLat = (point.lat - previous.lat) * METRES_PER_DEGREE_LAT;
      const dLon = (point.lon - previous.lon) * lonScale;
      const gap = Math.hypot(dLat, dLon);

      // Walk the gap at half-cell steps so no cell between two samples is missed.
      if (gap > cellSizeM / 2) {
        const steps = Math.min(Math.ceil((gap / cellSizeM) * 2), 2000);
        for (let s = 1; s < steps; s += 1) {
          const t = s / steps;
          cells.add(
            toCell({
              lat: previous.lat + (point.lat - previous.lat) * t,
              lon: previous.lon + (point.lon - previous.lon) * t,
            }),
          );
        }
      }
    }
    cells.add(toCell(point));
    previous = point;
  }

  return cells;
}

/**
 * Jaccard similarity: shared cells over total distinct cells.
 *
 * Symmetric and direction-agnostic. Two identical tracks score 1; two tracks with no
 * shared ground score 0. An out-and-back covering half a loop's unique ground scores
 * around 0.5 against it, which is why it does not merge at a high threshold.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  // Iterate the smaller set.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const cell of small) {
    if (large.has(cell)) shared += 1;
  }

  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}
