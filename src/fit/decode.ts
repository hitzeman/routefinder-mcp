import { Decoder, Stream } from "@garmin/fitsdk";

/**
 * FIT stores latitude and longitude as signed 32-bit semicircles. One semicircle is
 * 180 / 2^31 degrees, about 0.93 cm of latitude — verified against a real COROS file,
 * whose consecutive coordinate deltas have a GCD of exactly 1 semicircle. COROS writes
 * full device precision here; the ~111 m rounding seen in COROS summary responses is a
 * formatting artifact of that API, not a property of the file.
 */
const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;

export interface TrackPoint {
  lat: number;
  lon: number;
}

export interface Track {
  /** Positions in recorded order. Direction is preserved here even though grouping ignores it. */
  points: TrackPoint[];
  /** Metres. Taken from the session summary when present, else the final cumulative record. */
  totalDistanceM: number;
  /** ISO 8601 instant the activity started, used as its last-run date. */
  startTime: string;
  /** COROS sport label when the file declares one. */
  sport: string | null;
}

export type DecodeOutcome =
  | { ok: true; track: Track }
  | { ok: false; reason: string };

interface RecordMesg {
  positionLat?: number | null;
  positionLong?: number | null;
  distance?: number | null;
}

interface SessionMesg {
  totalDistance?: number | null;
  startTime?: Date | string | null;
  sport?: string | null;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Decode activity file bytes into a track.
 *
 * Returns a failure outcome rather than throwing for any file-level problem, so that one
 * bad activity cannot fail a batch.
 */
export function decodeActivity(bytes: Buffer): DecodeOutcome {
  let messages: Record<string, unknown[]>;

  try {
    const decoder = new Decoder(Stream.fromBuffer(bytes));

    if (!decoder.isFIT()) {
      return { ok: false, reason: "not a FIT file" };
    }
    if (!decoder.checkIntegrity()) {
      return { ok: false, reason: "FIT integrity check failed" };
    }

    const result = decoder.read();
    messages = result.messages as Record<string, unknown[]>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `FIT decode failed: ${detail}` };
  }

  const records = (messages.recordMesgs ?? []) as RecordMesg[];
  if (records.length === 0) {
    return { ok: false, reason: "FIT file contains no record messages" };
  }

  const points: TrackPoint[] = [];
  for (const record of records) {
    const { positionLat, positionLong } = record;
    if (typeof positionLat !== "number" || typeof positionLong !== "number") {
      continue;
    }
    points.push({
      lat: positionLat * SEMICIRCLES_TO_DEGREES,
      lon: positionLong * SEMICIRCLES_TO_DEGREES,
    });
  }

  if (points.length === 0) {
    return {
      ok: false,
      reason: "activity has no positional records and cannot describe a route",
    };
  }

  const session = ((messages.sessionMesgs ?? [])[0] ?? {}) as SessionMesg;

  let totalDistanceM = typeof session.totalDistance === "number" ? session.totalDistance : 0;
  if (totalDistanceM <= 0) {
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const distance = records[i]?.distance;
      if (typeof distance === "number" && distance > 0) {
        totalDistanceM = distance;
        break;
      }
    }
  }
  if (totalDistanceM <= 0) {
    return { ok: false, reason: "activity declares no total distance" };
  }

  const startTime = toIsoString(session.startTime);
  if (startTime === null) {
    return { ok: false, reason: "activity declares no start time" };
  }

  return {
    ok: true,
    track: {
      points,
      totalDistanceM,
      startTime,
      sport: typeof session.sport === "string" ? session.sport : null,
    },
  };
}
