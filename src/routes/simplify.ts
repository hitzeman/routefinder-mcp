import type { TrackPoint } from "../fit/decode.js";
import { perpendicularDistanceM } from "./geo.js";

/**
 * Ramer-Douglas-Peucker simplification.
 *
 * Chosen over a sampling or averaging reduction because it gives a bounded deviation
 * guarantee: no discarded point lies further than `toleranceM` from the retained
 * polyline. That bound is what the spec requires, and it is what lets the GeoJSON shrink
 * enough to pass through a context window without the drawn route drifting off its roads.
 *
 * Iterative rather than recursive: a 1 Hz hour-long track is a few thousand points, and a
 * pathological input should not risk a stack overflow.
 */
export function simplify(
  points: readonly TrackPoint[],
  toleranceM: number,
): TrackPoint[] {
  if (points.length <= 2 || toleranceM <= 0) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const [first, last] = frame;
    if (last - first < 2) continue;

    const start = points[first];
    const end = points[last];
    if (start === undefined || end === undefined) continue;

    let worstIndex = -1;
    let worstDistance = -1;

    for (let i = first + 1; i < last; i += 1) {
      const candidate = points[i];
      if (candidate === undefined) continue;
      const distance = perpendicularDistanceM(candidate, start, end);
      if (distance > worstDistance) {
        worstDistance = distance;
        worstIndex = i;
      }
    }

    if (worstIndex !== -1 && worstDistance > toleranceM) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  const result: TrackPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (keep[i] === 1 && point !== undefined) result.push(point);
  }
  return result;
}

/**
 * Largest distance from any original point to the simplified polyline, in metres.
 *
 * Used by tests to assert the tolerance guarantee actually holds rather than trusting the
 * implementation.
 */
export function maxDeviationM(
  original: readonly TrackPoint[],
  simplified: readonly TrackPoint[],
): number {
  if (simplified.length < 2) return 0;

  let worst = 0;
  for (const point of original) {
    let best = Infinity;
    for (let i = 0; i < simplified.length - 1; i += 1) {
      const a = simplified[i];
      const b = simplified[i + 1];
      if (a === undefined || b === undefined) continue;
      best = Math.min(best, perpendicularDistanceM(point, a, b));
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/**
 * Reduce a polyline to at most `maxVertices` points.
 *
 * Applied after RDP as a hard ceiling on output size: RDP's tolerance bounds *shape
 * error* but not point count, and the GeoJSON has to fit in a context window. Raises the
 * tolerance geometrically until the count fits, so the result is still an RDP
 * simplification, just a coarser one.
 */
export function simplifyToBudget(
  points: readonly TrackPoint[],
  toleranceM: number,
  maxVertices: number,
): { points: TrackPoint[]; toleranceM: number } {
  let tolerance = toleranceM;
  let result = simplify(points, tolerance);

  // Bounded loop: tolerance doubles each pass, so this terminates quickly.
  for (let attempt = 0; attempt < 24 && result.length > maxVertices; attempt += 1) {
    tolerance *= 2;
    result = simplify(points, tolerance);
  }

  return { points: result, toleranceM: tolerance };
}
