import fs from "node:fs";
import path from "node:path";

import { Encoder, Profile } from "@garmin/fitsdk";

import { projectRoot } from "../../src/config.js";

const DEGREES_TO_SEMICIRCLES = 2 ** 31 / 180;

/**
 * The SDK types message numbers behind an index signature and `writeMesg` against a
 * nominal `Encodable<Mesg>`, neither of which a plain literal satisfies. Narrow both
 * once here rather than at every call site.
 */
type MesgInput = Parameters<Encoder["writeMesg"]>[0];

const MESG_FILE_ID = Profile.MesgNum.FILE_ID as number;
const MESG_RECORD = Profile.MesgNum.RECORD as number;
const MESG_SESSION = Profile.MesgNum.SESSION as number;

export interface SyntheticPoint {
  lat: number;
  lon: number;
}

export interface SyntheticFitOptions {
  points: SyntheticPoint[];
  /** Metres. Defaults to a value derived from the point count. */
  totalDistanceM?: number;
  startTime?: Date;
  sport?: string;
  /** Omit position fields entirely, producing a valid but positionless activity. */
  withoutPositions?: boolean;
}

/**
 * Build a real, integrity-valid FIT file in memory.
 *
 * Synthesizing fixtures keeps GPS-bearing binaries out of the repository while still
 * exercising the production decode path rather than a stub.
 */
export function syntheticFit(options: SyntheticFitOptions): Buffer {
  const {
    points,
    totalDistanceM = Math.max(points.length - 1, 1) * 3,
    startTime = new Date("2026-01-01T12:00:00Z"),
    sport = "running",
    withoutPositions = false,
  } = options;

  const encoder = new Encoder();

  encoder.writeMesg({
    mesgNum: MESG_FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 1,
    serialNumber: 1,
    timeCreated: startTime,
  } as MesgInput);

  const startMs = startTime.getTime();
  points.forEach((point, index) => {
    const record: Record<string, unknown> = {
      mesgNum: MESG_RECORD,
      timestamp: new Date(startMs + index * 1000),
      distance: (totalDistanceM * index) / Math.max(points.length - 1, 1),
    };
    if (!withoutPositions) {
      record.positionLat = Math.round(point.lat * DEGREES_TO_SEMICIRCLES);
      record.positionLong = Math.round(point.lon * DEGREES_TO_SEMICIRCLES);
    }
    encoder.writeMesg(record as unknown as MesgInput);
  });

  encoder.writeMesg({
    mesgNum: MESG_SESSION,
    timestamp: new Date(startMs + points.length * 1000),
    startTime,
    totalDistance: totalDistanceM,
    sport,
  } as MesgInput);

  return Buffer.from(encoder.close());
}

/** A valid FIT activity whose records carry no position fields at all. */
export function positionlessFit(): Buffer {
  const points = Array.from({ length: 6 }, () => ({ lat: 0, lon: 0 }));
  return syntheticFit({ points, withoutPositions: true });
}

export const sampleFitPath = path.join(
  projectRoot,
  ".cache",
  "fixtures",
  "sample.fit",
);

/**
 * The real COROS activity file, when it is present locally.
 *
 * Returns null rather than throwing so the suite stays green on a machine that has not
 * ingested anything. FIT files are gitignored: they contain full-resolution home GPS.
 */
export function loadSampleFit(): Buffer | null {
  try {
    return fs.readFileSync(sampleFitPath);
  } catch {
    return null;
  }
}
