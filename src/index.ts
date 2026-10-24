// Initialize OpenTelemetry FIRST so auto-instrumentation can patch http/express
// before they are imported below. No-op unless OTEL is configured (see lib/tracing.ts).
import "./lib/tracing";
import dotenv from "dotenv";
import app from "./app";
import { DOCS_PATH, SPEC_TTL_MS, upstreams } from "./lib/config";
import { logger } from "./lib/logger";

dotenv.config();

const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  logger.info(
    {
      component: "startup",
      port,
      docs_path: DOCS_PATH,
      spec_ttl_ms: SPEC_TTL_MS,
      upstreams: upstreams.map((u) => u.key),
    },
    `apidocs-api-server listening on port ${port}${DOCS_PATH}`,
  );
});

const shutdown = (signal: string) => {
  logger.info({ component: "shutdown", signal }, "shutting down");
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
