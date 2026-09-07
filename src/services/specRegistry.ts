/**
 * Fetches and caches each upstream's OpenAPI spec.
 *
 * Design notes:
 * - Lazy, not eager. Specs are fetched on first request and refreshed once the TTL
 *   expires, so a service redeployed with new endpoints shows up without restarting
 *   this one, and a cold upstream does not block our own startup.
 * - Fails soft, per upstream. A dead service degrades its own dropdown entry only. If
 *   we have a stale spec cached we keep serving it; otherwise that one entry 503s while
 *   the rest of the page renders normally.
 * - Single-flight. Concurrent requests for the same upstream share one in-flight fetch
 *   rather than stampeding a recovering service.
 */
import axios from "axios";
import {
  SPEC_FETCH_TIMEOUT_MS,
  SPEC_TTL_MS,
  Upstream,
  upstreams,
} from "../lib/config";
import { createComponentLogger, logCanonical } from "../lib/logger";
import {
  specAvailable,
  specFetchFailure,
  specFetchSuccess,
} from "../lib/promMetrics";

const log = createComponentLogger("spec-registry");

interface CacheEntry {
  /** Last successfully fetched spec, if we have ever gotten one. */
  spec?: unknown;
  /** When `spec` was fetched. */
  fetchedAt?: number;
  /** In-flight fetch, used to collapse concurrent requests. */
  inFlight?: Promise<unknown>;
  /** Error from the most recent attempt, when that attempt failed. */
  lastError?: string;
}

const cache = new Map<string, CacheEntry>();

/**
 * Human-readable failure cause.
 *
 * Needed because the obvious `err.message` is empty for the most common failure here:
 * Node wraps a refused connection to a host resolving to both IPv4 and IPv6 in an
 * AggregateError whose own message is ''. Without unwrapping, /healthz would report a
 * blank error precisely when an upstream is down.
 */
const describeError = (err: unknown): string => {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status) {
      return `HTTP ${status} from upstream`;
    }
    if (err.code) {
      return err.code;
    }
  }
  // Structural check rather than `instanceof AggregateError`, which needs lib ES2021.
  const aggregate = err as { errors?: unknown } | null;
  if (aggregate && Array.isArray(aggregate.errors)) {
    const causes = aggregate.errors
      .map((e: unknown) => {
        const inner = e as { code?: string; message?: string } | null;
        return inner?.code || inner?.message;
      })
      .filter((c): c is string => Boolean(c));
    if (causes.length > 0) {
      return causes.filter((c, i) => causes.indexOf(c) === i).join("; ");
    }
  }
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
};

const byKey = new Map<string, Upstream>(upstreams.map((u) => [u.key, u]));

export const isKnownUpstream = (key: string): boolean => byKey.has(key);

export { describeError };

const isFresh = (entry: CacheEntry): boolean =>
  entry.spec !== undefined &&
  entry.fetchedAt !== undefined &&
  Date.now() - entry.fetchedAt < SPEC_TTL_MS;

const fetchSpec = async (upstream: Upstream): Promise<unknown> => {
  const url = `${upstream.baseUrl.replace(/\/$/, "")}/openapi.json`;
  const startedAt = Date.now();

  // Default validateStatus is wanted here: a 404/500 from an upstream must throw so we
  // fall back to a stale copy (or surface the failure) rather than caching an error body.
  const response = await axios.get(url, { timeout: SPEC_FETCH_TIMEOUT_MS });

  if (typeof response.data !== "object" || response.data === null) {
    throw new Error(
      `upstream returned a non-object body (${typeof response.data})`,
    );
  }

  logCanonical(
    log.child({ upstream: upstream.key }),
    "fetched upstream openapi spec",
    {
      duration_ms: Date.now() - startedAt,
      status: "success",
    },
  );

  return response.data;
};

/**
 * Returns a usable spec for `key`, or throws if none can be produced.
 *
 * Order of preference: fresh cache, then a live fetch, then a stale cached copy.
 */
export const getSpec = async (key: string): Promise<unknown> => {
  const upstream = byKey.get(key);
  if (!upstream) {
    throw new Error(`unknown upstream: ${key}`);
  }

  const entry = cache.get(key) ?? {};
  cache.set(key, entry);

  if (isFresh(entry)) {
    return entry.spec;
  }

  if (!entry.inFlight) {
    entry.inFlight = fetchSpec(upstream)
      .then((spec) => {
        entry.spec = spec;
        entry.fetchedAt = Date.now();
        entry.lastError = undefined;
        specFetchSuccess.inc({ upstream: key });
        specAvailable.set({ upstream: key }, 1);
        return spec;
      })
      .catch((err: unknown) => {
        const message = describeError(err);
        entry.lastError = message;
        specFetchFailure.inc({ upstream: key });
        specAvailable.set({ upstream: key }, entry.spec === undefined ? 0 : 1);

        // Optional upstreams (internal-only or legacy) are expected to be absent
        // in some environments, so they do not warrant a warning.
        const line = { upstream: key, url: upstream.baseUrl, error: message };
        if (upstream.optional) {
          log.debug(line, "optional upstream spec unavailable");
        } else {
          log.warn(line, "upstream spec fetch failed");
        }
        throw err;
      })
      .finally(() => {
        entry.inFlight = undefined;
      });
  }

  try {
    return await entry.inFlight;
  } catch (err) {
    // Serve a stale copy rather than nothing: out-of-date docs beat a broken page.
    if (entry.spec !== undefined) {
      log.warn(
        { upstream: key, age_ms: Date.now() - (entry.fetchedAt ?? 0) },
        "serving stale cached spec after failed refresh",
      );
      return entry.spec;
    }
    throw err;
  }
};

/** Last recorded error per upstream, for the health endpoint. */
export const getStatus = () =>
  upstreams.map((u) => {
    const entry = cache.get(u.key);
    return {
      upstream: u.key,
      optional: u.optional,
      cached: entry?.spec !== undefined,
      fetched_at: entry?.fetchedAt
        ? new Date(entry.fetchedAt).toISOString()
        : null,
      last_error: entry?.lastError ?? null,
    };
  });
