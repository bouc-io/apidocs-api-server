/**
 * Prometheus metrics for this service (exposed at GET /metrics).
 *
 * Scraped by Prometheus via the chart's `prometheus.io/scrape` pod annotation.
 *
 * Default (process/node) metrics, labelled with `service` + `environment` to line up
 * with the collector-stamped `otel_*` series in Grafana, plus two counters specific to
 * this service so a silently-failing upstream is visible without reading logs.
 */
import client from "prom-client";

export const register = new client.Registry();
register.setDefaultLabels({
  /* eslint-disable @typescript-eslint/no-require-imports */
  service:
    process.env.OTEL_SERVICE_NAME ||
    (require("../../package.json") as { name: string }).name,
  /* eslint-enable @typescript-eslint/no-require-imports */
  environment: process.env.ENVIRONMENT_ID || "unknown",
});
client.collectDefaultMetrics({ register });

/** Successful upstream spec fetches, by upstream key. */
export const specFetchSuccess = new client.Counter({
  name: "apidocs_spec_fetch_success_total",
  help: "Successful OpenAPI spec fetches from an upstream service",
  labelNames: ["upstream"],
  registers: [register],
});

/** Failed upstream spec fetches, by upstream key. */
export const specFetchFailure = new client.Counter({
  name: "apidocs_spec_fetch_failure_total",
  help: "Failed OpenAPI spec fetches from an upstream service",
  labelNames: ["upstream"],
  registers: [register],
});

/** Whether the last fetch for an upstream succeeded (1) or failed (0). */
export const specAvailable = new client.Gauge({
  name: "apidocs_spec_available",
  help: "Whether a usable OpenAPI spec is currently cached for an upstream",
  labelNames: ["upstream"],
  registers: [register],
});
