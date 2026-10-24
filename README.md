# apidocs-api-server

Aggregated OpenAPI documentation for the bouc.io platform. One URL, every service:

```
https://api.<CLUSTER_DOMAIN>/v1/api-docs
```

Swagger UI's built-in service selector lists each API. Specs are **not** merged, so
nothing collides between services.

## Role in the platform

Each API server mounts its own Swagger UI at `/api-docs`, but none of those paths are
routed at the Istio edge, and all five collide on the same path with no way to pick a
service. This service is the single edge-routed entry point.

## How it works

```
browser ──► https://api.<DOMAIN>/v1/api-docs
              │  istio gateway ──► oauth2-proxy ──► apidocs-api-chart
              ▼
         apidocs-api-server
              │  east-west, in-mesh, never routed at the edge
              ├──► http://agent-api-chart.default.svc.cluster.local/openapi.json
              ├──► http://memory-api-chart.default.svc.cluster.local/openapi.json
              ├──► http://admin-api-chart.default.svc.cluster.local/openapi.json
              ├──► http://portal-api-chart.default.svc.cluster.local/openapi.json
              └──► http://memory-distiller-chart.default.svc.cluster.local/openapi.json
```

The fan-out happens **server-side over cluster DNS**, and each spec is re-served
same-origin at `/v1/api-docs/specs/<key>.json`. Two consequences:

- **No cross-origin traffic.** The browser only ever talks to `api.<DOMAIN>`, so no CORS
  allowlist entries are needed anywhere.
- **Upstream specs stay internal.** The `/openapi.json` endpoints are reachable from
  inside the mesh only; they are not routed at the gateway.

Specs are fetched lazily and cached with a TTL (default 5 minutes), so a service
redeployed with new endpoints appears without restarting this one.

### Failure behaviour

One dead upstream degrades its own dropdown entry only. If a stale spec is cached it
keeps being served (out-of-date docs beat a broken page); otherwise that single entry
returns 503 while the rest of the page renders normally.

## API overview

| Path | Purpose |
|---|---|
| `/v1/api-docs` | Aggregated Swagger UI |
| `/v1/api-docs/specs/<key>.json` | One upstream's spec, re-served same-origin |
| `/healthz` | Liveness/readiness. Always 200 while the process is up; per-upstream state in the body |
| `/metrics` | Prometheus (default process metrics + `apidocs_spec_*`) |

`<key>` is one of `agent`, `memory`, `admin`, `portal`, `distiller`.

> **The mount path is load-bearing.** Swagger UI resolves its own assets relatively, so
> the app mounts on the same absolute path it is served on (`/v1/api-docs`). Mounting on
> `/api-docs` and rewriting at the gateway renders a blank page.

## Local development

```bash
npm install
cp .env.example .env   # point the *_API_URL vars at your local services
npm run dev
```

Then open <http://localhost:3000/v1/api-docs>.

The upstream services all default to `PORT=3000`, so run each on a distinct port and set
the matching `*_API_URL`. You do not need all six running: missing ones simply show as
unavailable in the dropdown.

```bash
npm run build    # TypeScript -> dist/
npm start        # run compiled
npm test         # vitest (no tests yet; passes with none)
npm run format   # prettier
```

## Environment variables

See `.env.example`. Every upstream URL is overridable; defaults are the in-cluster
service names. Note these are the `*-api-chart` services (the APIs), not
`*-chart-service` (the UIs).

## Deployment

Helm chart lives in a separate repo: `apidocs-api-chart`.

Reaching this service from outside the cluster requires `/v1/api-docs` to be registered
in **both** the Istio `boucio-api-virtualservice` **and** the oauth2-proxy `upstreams`
list, in **both** the local and sandbox environments. Because all external
`api.<DOMAIN>` traffic passes through oauth2-proxy, the docs inherit Keycloak login.

> An OpenAPI spec served to a logged-in user is visible to every logged-in user,
> including any admin-only endpoints. Redaction, if wanted, is a per-spec concern.

## Quality Gates

```bash
npm run lint          # ESLint (flat config)
npm run lint:fix      # auto-fix what is mechanically fixable
npm run format:check  # prettier, check only
npm run format        # prettier, write
npm run build         # tsc
npm test              # vitest, unit tests only
npm run test:ci       # vitest + coverage, writes junit.xml and coverage/
```

CI runs `lint` and `unit-test` from the shared `bouc-io/ci-templates` project.

- **Lint uses a warning ratchet.** ESLint *errors* always fail the build. Warnings are
  capped by `max_warnings` in `.gitlab-ci.yml`, currently **0**. When you
  clean some up, lower the number. Never raise it, and never silence a rule repo-wide to
  get green.
- **Formatting is enforced.** `format:check` gates, using prettier defaults with no config
  file.
- **No tests exist yet.** `test` and `test:ci` carry `--passWithNoTests`, so the gate is
  green without testing anything. Remove that flag as soon as real tests land.

Two things to know before you ever run a bulk reformat here:

- **Prettier needs two passes.** It breaks some method chains across lines on the first
  pass and collapses them back on the second, so a single
  `npm run format` can leave `format:check` failing.
- **Prettier can wrap a statement out from under an `eslint-disable-next-line`.** That is
  why the suppressions in this repo use block `/* eslint-disable rule */ ... /* eslint-enable rule */`
  pairs, which survive re-wrapping. Keep them that way.

## License

[Elastic License 2.0](./LICENSE) — source-available; not OSI open source.
