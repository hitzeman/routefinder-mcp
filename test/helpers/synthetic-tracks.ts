import type { CachedTrack } from "../../src/cache/store.js";
import type { TrackPoint } from "../../src/fit/decode.js";
import { METRES_PER_DEGREE_LAT, metresPerDegreeLon } from "../../src/routes/geo.js";

const ORIGIN = { lat: 33.2, lon: -96.7 };

/** Offset from the origin by metres, so fixtures can be described in real distances. */
export function pointAt(eastM: number, northM: number): TrackPoint {
  return {
    lat: ORIGIN.lat + northM / METRES_PER_DEGREE_LAT,
    lon: ORIGIN.lon + eastM / metresPerDegreeLon(ORIGIN.lat),
  };
}

/** A closed rectangular loop, sampled every `stepM` metres. */
export function rectangleLoop(
  widthM: number,
  heightM: number,
  stepM = 10,
  offsetEastM = 0,
  offsetNorthM = 0,
): TrackPoint[] {
  const corners: Array<[number, number]> = [
    [offsetEastM, offsetNorthM],
    [offsetEastM + widthM, offsetNorthM],
    [offsetEastM + widthM, offsetNorthM + heightM],
    [offsetEastM, offsetNorthM + heightM],
    [offsetEastM, offsetNorthM],
  ];

  const points: TrackPoint[] = [];
  for (let i = 0; i < corners.length - 1; i += 1) {
    const [x0, y0] = corners[i]!;
    const [x1, y1] = corners[i + 1]!;
    const span = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(span / stepM));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      points.push(pointAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
    }
  }
  points.push(pointAt(...corners[corners.length - 1]!));
  return points;
}

/** An out-and-back along a straight line: covers half the unique ground of a loop. */
export function outAndBack(lengthM: number, stepM = 10): TrackPoint[] {
  const outward: TrackPoint[] = [];
  const steps = Math.max(1, Math.round(lengthM / stepM));
  for (let s = 0; s <= steps; s += 1) {
    outward.push(pointAt((lengthM * s) / steps, 0));
  }
  return [...outward, ...outward.slice(0, -1).reverse()];
}

/** Many laps of a small oval: the track-workout shape. */
export function smallOvalLaps(
  laps: number,
  widthM = 100,
  heightM = 40,
): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let lap = 0; lap < laps; lap += 1) {
    points.push(...rectangleLoop(widthM, heightM, 5));
  }
  return points;
}

/** Nudge every point by a small random-but-deterministic amount, simulating GPS jitter. */
export function jitter(points: readonly TrackPoint[], metres: number): TrackPoint[] {
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  return points.map((point) => ({
    lat: point.lat + (next() * metres * 2) / METRES_PER_DEGREE_LAT,
    lon: point.lon + (next() * metres * 2) / metresPerDegreeLon(point.lat),
  }));
}

let keyCounter = 0;

export function trackFrom(
  points: TrackPoint[],
  options: { distanceM?: number; startTime?: string; key?: string } = {},
): CachedTrack {
  keyCounter += 1;
  const key =
    options.key ?? keyCounter.toString(16).padStart(64, "0");
  return {
    key,
    points,
    totalDistanceM: options.distanceM ?? 11_300,
    startTime: options.startTime ?? "2026-01-01T12:00:00.000Z",
    sport: "running",
  };
}

export function resetKeyCounter(): void {
  keyCounter = 0;
}
