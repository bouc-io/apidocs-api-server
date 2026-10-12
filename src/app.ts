import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { DOCS_PATH, upstreams } from "./lib/config";
import { createComponentLogger } from "./lib/logger";
import { register as metricsRegister } from "./lib/promMetrics";
import {
  describeError,
  getSpec,
  getStatus,
  isKnownUpstream,
} from "./services/specRegistry";

const log = createComponentLogger("app");

const app = express();

// Swagger UI injects inline styles and needs its own assets; the default helmet CSP
// blocks them and renders a blank page. Everything served here is same-origin static
// documentation, so the directive is scoped rather than disabling helmet outright.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'", "https:"],
        "img-src": ["'self'", "data:", "https:"],
      },
    },
  }),
);
app.use(cors());
app.use(express.json());

// Prometheus metrics (scraped via the chart's prometheus.io/scrape annotation)
app.get("/metrics", async (_req: Request, res: Response) => {
  res.set("Content-Type", metricsRegister.contentType);
  res.end(await metricsRegister.metrics());
});

/**
 * Liveness/readiness. Always 200 when the process is up: this service is useful even
 * when some upstreams are down, so a failing upstream must not fail our own probe.
 * Per-upstream state is reported in the body for debugging.
 */
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    upstreams: getStatus(),
  });
});

/**
 * Each upstream spec, re-served same-origin. The Swagger UI dropdown points here rather
 * than at the upstream services directly, so the browser makes no cross-origin request
 * and the upstream `/openapi.json` paths stay unrouted at the edge.
 */
app.get(`${DOCS_PATH}/specs/:key.json`, async (req: Request, res: Response) => {
  // @types/express v5 widens params to string | string[]; normalise before lookup.
  const raw = req.params.key;
  const key = Array.isArray(raw) ? raw[0] : raw;

  if (!isKnownUpstream(key)) {
    res.status(404).json({ error: "unknown service", service: key });
    return;
  }

  try {
    res.json(await getSpec(key));
  } catch (err) {
    const message = describeError(err);
    log.warn(
      { upstream: key, error: message },
      "could not serve upstream spec",
    );
    res.status(503).json({
      error: "spec unavailable",
      service: key,
      detail: message,
    });
  }
});

/**
 * Aggregated Swagger UI.
 *
 * Mounted on the same absolute path it is served on externally
 * (api.<domain>/v1/api-docs), because Swagger UI resolves its own assets relatively.
 * Mounting on `/api-docs` and rewriting at the gateway would produce a blank page.
 *
 * `swaggerUi.setup(null, ...)` with `urls` is the built-in multi-spec explorer: no spec
 * merging, so nothing can collide between services.
 */
app.use(
  DOCS_PATH,
  swaggerUi.serve,
  swaggerUi.setup(null, {
    explorer: true,
    swaggerOptions: {
      urls: upstreams.map((u) => ({
        url: `${DOCS_PATH}/specs/${u.key}.json`,
        name: u.label,
      })),
      // Disable the "validator badge". Left unset, Swagger UI hands each spec URL to
      // the public https://validator.swagger.io, which then tries to fetch it itself.
      // Two problems: it cannot reach api.<domain> (internal-only, behind
      // oauth2-proxy), so every definition renders a misleading red INVALID badge
      // reading "Can't read from file ..."; and it leaks our internal hostnames and
      // API paths to a third party on every page load.
      validatorUrl: null,
    },
    customSiteTitle: "bouc.io API documentation",
  }),
);

// Convenience redirect so the bare path lands on the docs rather than a 404.
app.get("/", (_req: Request, res: Response) => res.redirect(DOCS_PATH));

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "not found", path: req.originalUrl });
});

export default app;
