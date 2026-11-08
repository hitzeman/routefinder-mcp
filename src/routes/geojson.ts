import type { DiscoverResult, Route } from "./discover.js";

/**
 * GeoJSON uses [longitude, latitude] order, which is the reverse of how coordinates are
 * usually spoken. Getting it backwards puts Texas in the Indian Ocean.
 */
function toCoordinates(route: Route): Array<[number, number]> {
  return route.geometry.map((point) => [
    Number(point.lon.toFixed(6)),
    Number(point.lat.toFixed(6)),
  ]);
}

export interface RouteFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  properties: {
    id: string;
    label: string;
    distanceMiles: number;
    runCount: number;
    lastRunDate: string;
    firstRunDate: string;
  };
}

export interface RouteFeatureCollection {
  type: "FeatureCollection";
  features: RouteFeature[];
}

/**
 * One feature per route, selection details as properties.
 *
 * Coordinates are rounded to six decimal places - about 11 cm, far finer than any route
 * distinction and a meaningful size saving over full float precision.
 */
export function toGeoJson(result: DiscoverResult): RouteFeatureCollection {
  return {
    type: "FeatureCollection",
    features: result.routes.map((route) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: toCoordinates(route),
      },
      properties: {
        id: route.id,
        label: route.label,
        distanceMiles: route.distanceMiles,
        runCount: route.runCount,
        lastRunDate: route.lastRunDate,
        firstRunDate: route.firstRunDate,
      },
    })),
  };
}

/** Human-readable summary, so the answer is legible without reading the GeoJSON. */
export function summarize(result: DiscoverResult): string {
  if (result.state === "empty-cache") {
    return "No activities have been ingested yet. Run ingest_activities first.";
  }

  if (result.state === "no-match") {
    return (
      `No cached activity matched this distance. ${result.cachedCount} activities are ` +
      `cached, but none fall in the requested range.` +
      (result.excluded.length > 0
        ? ` ${result.excluded.length} were excluded as repeated laps of a small circuit.`
        : "")
    );
  }

  const lines = [
    `Found ${result.routes.length} distinct route${result.routes.length === 1 ? "" : "s"} ` +
      `across ${result.consideredCount} matching activities:`,
  ];

  for (const route of result.routes) {
    const lastRun = route.lastRunDate.slice(0, 10);
    lines.push(
      `  ${route.label}: ${route.distanceMiles} mi, run ${route.runCount} ` +
        `time${route.runCount === 1 ? "" : "s"}, last run ${lastRun}`,
    );
  }

  if (result.excluded.length > 0) {
    lines.push(
      `Excluded ${result.excluded.length} activity/activities as repeated laps of a small circuit.`,
    );
  }

  return lines.join("\n");
}
