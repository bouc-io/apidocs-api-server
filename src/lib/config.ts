/**
 * Upstream registry: which services this aggregator pulls OpenAPI specs from.
 *
 * Every URL here is resolved over the cluster network (east-west traffic). None of the
 * upstream `/openapi.json` paths are routed at the Istio edge, so they are reachable
 * from inside the mesh only. The browser never calls them directly; it only ever talks
 * to this service, which re-serves each spec same-origin under DOCS_PATH.
 */

/** Absolute path this service mounts on. Must match the Istio route prefix exactly. */
export const DOCS_PATH = "/v1/api-docs";

export interface Upstream {
  /** Slug used in the spec URL: <DOCS_PATH>/specs/<key>.json */
  key: string;
  /** Label shown in the Swagger UI service selector. */
  label: string;
  /** Base URL of the upstream service. */
  baseUrl: string;
  /**
   * When true, a fetch failure is logged at debug rather than warn. Used for services
   * that are internal-only or legacy, where a missing spec is not noteworthy.
   */
  optional: boolean;
}

const env = (name: string, fallback: string): string =>
  process.env[name] || fallback;

/**
 * Defaults point at the in-cluster service names. Note these are the `*-api-chart`
 * services (the APIs); `*-chart-service` names belong to the UIs.
 */
export const upstreams: Upstream[] = [
  {
    key: "agent",
    label: "agent-api",
    baseUrl: env(
      "AGENT_API_URL",
      "http://agent-api-chart.default.svc.cluster.local",
    ),
    optional: false,
  },
  {
    key: "memory",
    label: "memory-api",
    baseUrl: env(
      "MEMORY_API_URL",
      "http://memory-api-chart.default.svc.cluster.local",
    ),
    optional: false,
  },
  {
    key: "admin",
    label: "admin-api",
    baseUrl: env(
      "ADMIN_API_URL",
      "http://admin-api-chart.default.svc.cluster.local",
    ),
    optional: false,
  },
  {
    key: "portal",
    label: "portal-api",
    baseUrl: env(
      "PORTAL_API_URL",
      "http://portal-api-chart.default.svc.cluster.local",
    ),
    optional: false,
  },
  {
    key: "chatbot",
    label: "chatbot-api (legacy)",
    baseUrl: env(
      "CHATBOT_API_URL",
      "http://chatbot-api-chart.default.svc.cluster.local",
    ),
    optional: true,
  },
  {
    key: "distiller",
    label: "memory-distiller",
    baseUrl: env(
      "DISTILLER_API_URL",
      "http://memory-distiller-chart.default.svc.cluster.local",
    ),
    optional: true,
  },
];

/** How long a successfully fetched spec is reused before refetching. */
export const SPEC_TTL_MS = Number(env("SPEC_TTL_MS", String(5 * 60 * 1000)));

/** Per-upstream HTTP timeout. Kept short so one slow service cannot stall the page. */
export const SPEC_FETCH_TIMEOUT_MS = Number(
  env("SPEC_FETCH_TIMEOUT_MS", "5000"),
);
