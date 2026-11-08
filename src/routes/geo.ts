import type { TrackPoint } from "../fit/decode.js";

export const METRES_PER_DEGREE_LAT = 111_320;

export const MILES_TO_METRES = 1609.344;

/**
 * Metres per degree of longitude at a given latitude.
 *
 * Longitude degrees shrink toward the poles. At this project's latitude the factor is
 * about 0.84, so ignoring it would make east-west cells ~19% wider than north-south ones
 * and bias the overlap metric directionally.
 */
export function metresPerDegreeLon(latDegrees: number): number {
  return METRES_PER_DEGREE_LAT * Math.cos((latDegrees * Math.PI) / 180);
}

/** Planar approximation, accurate well past the scale of a single run. */
export function distanceM(a: TrackPoint, b: TrackPoint): number {
  const midLat = (a.lat + b.lat) / 2;
  const dLat = (b.lat - a.lat) * METRES_PER_DEGREE_LAT;
  const dLon = (b.lon - a.lon) * metresPerDegreeLon(midLat);
  return Math.hypot(dLat, dLon);
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export function boundingBox(points: readonly TrackPoint[]): BoundingBox {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const point of points) {
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
    if (point.lon < minLon) minLon = point.lon;
    if (point.lon > maxLon) maxLon = point.lon;
  }

  return { minLat, maxLat, minLon, maxLon };
}

/** Diagonal of the bounding box in metres, a cheap proxy for spatial extent. */
export function extentM(points: readonly TrackPoint[]): number {
  if (points.length === 0) return 0;
  const box = boundingBox(points);
  const midLat = (box.minLat + box.maxLat) / 2;
  const height = (box.maxLat - box.minLat) * METRES_PER_DEGREE_LAT;
  const width = (box.maxLon - box.minLon) * metresPerDegreeLon(midLat);
  return Math.hypot(height, width);
}

/** Perpendicular distance from `point` to the segment `start`-`end`, in metres. */
export function perpendicularDistanceM(
  point: TrackPoint,
  start: TrackPoint,
  end: TrackPoint,
): number {
  const midLat = (start.lat + end.lat) / 2;
  const lonScale = metresPerDegreeLon(midLat);

  const px = (point.lon - start.lon) * lonScale;
  const py = (point.lat - start.lat) * METRES_PER_DEGREE_LAT;
  const ex = (end.lon - start.lon) * lonScale;
  const ey = (end.lat - start.lat) * METRES_PER_DEGREE_LAT;

  const segmentLengthSq = ex * ex + ey * ey;
  if (segmentLengthSq === 0) return Math.hypot(px, py);

  // Project onto the segment, clamped to its endpoints.
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / segmentLengthSq));
  return Math.hypot(px - t * ex, py - t * ey);
}
