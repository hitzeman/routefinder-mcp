import path from "node:path";

/** Repository root, resolved from this module's compiled location in dist/src. */
export const projectRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * Cache root. Holds full-resolution GPS and must stay out of version control.
 * Override with ROUTEFINDER_CACHE_DIR, which the tests use for isolation.
 */
export const cacheDir = process.env.ROUTEFINDER_CACHE_DIR
  ? path.resolve(process.env.ROUTEFINDER_CACHE_DIR)
  : path.join(projectRoot, ".cache");
