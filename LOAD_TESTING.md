# Load Testing Guide

CrowdSec Web UI includes a deterministic fake LAPI and synthetic SQLite dataset for testing bootstrap, paging, filtering, refreshes, and multi-instance behavior without a large production CrowdSec deployment.

- Contributor setup: [DEVELOPMENT.md](DEVELOPMENT.md)
- Operator setup and configuration: [README.md](README.md)

## Quick Start

Run the default profile locally.

```bash
./run.sh loadtest
# equivalent
./run.sh loadtest default
```

The workflow seeds the source database, builds the frontend, imports through the normal bootstrap path, and starts the UI at `http://localhost:3000/`.

### Authentication

| Setting | Value |
| --- | --- |
| Username | `load` |
| Password | `test` |
| Authentication | Enabled; set `CONFIG_AUTH_ENABLED=false` to disable |
| Passkey | Dummy credential for exercising the button and request; authentication is expected to fail |

Load-test mode logs seed timings, synchronization progress, `/api` requests, and event-loop stalls of at least `100ms`.

## Profiles

```bash
./run.sh loadtest default
./run.sh loadtest blocklist
./run.sh loadtest blocklists-mixed
./run.sh loadtest multi-instance
./run.sh loadtest multi-instance-medium
```

| Profile | Initial workload | Main use |
| --- | --- | --- |
| `default` | 300,000 alerts, 300,000 decisions, one 100,000-decision blocklist | General bootstrap, dashboard, filtering, paging, and refresh baseline |
| `blocklist` | 7,582 alerts, 410,463 decisions, 199,069-decision blocklist, 53,500-decision refreshes | Concentrated CAPI/LISTS workload |
| `blocklists-mixed` | 10,000 alerts, 500,000 decisions; blocklists of 125,000, 100,000, and 60,000 | Empty, expired, expiring, and large delta-blocklist cases |
| `multi-instance` | Primary 25k/25k, Secondary 15k/15k, Edge 10k/10k alerts/decisions | Quick multi-instance and colliding upstream-ID checks |
| `multi-instance-medium` | Three instances with 100,000 alerts and 100,000 decisions each | Medium multi-instance benchmarking |

### Profile details

- `default` distributes remaining decisions across regular alerts and includes active, expired, simulated, and duplicate-value cases. Each minute adds 100 alerts and 100 decisions.
- `blocklist` splits refresh decisions across LISTS and CAPI alerts and enables the CAPI filter.
- `blocklists-mixed` also creates 1,000 alerts without decisions, 500 alerts with expired decisions, and 8,000 decisions that expire 5–15 minutes after seeding. Each refresh adds three blocklist alerts with 1,000–25,000 decisions per alert and alternating LISTS/CAPI origins.
- In multi-instance profiles, IDs start at `1` independently for each fake LAPI. Primary exposes two metrics endpoints, Secondary one, and Edge none.
- Set `LOADTEST_FAILING_LAPI=true` to make Edge fail for partial-availability and partial-write tests.

Defaults live in `scripts/load-test-profiles/`. Explicit `LOADTEST_*` and `CONFIG_*` environment variables take precedence.

## Benchmark List, Search, and Facet Requests

For the standard 300k/300k profile, disable authentication for the benchmark client, wait for bootstrap to finish, and run:

```bash
CONFIG_AUTH_ENABLED=false ./run.sh loadtest
pnpm run loadtest:benchmark:multi
```

For a multi-instance profile, target its Primary instance explicitly:

```bash
CONFIG_AUTH_ENABLED=false ./run.sh loadtest multi-instance
LOADTEST_BENCHMARK_INSTANCE=primary pnpm run loadtest:benchmark:multi
```

The benchmark measures cold and warm low-cardinality, alert-decision-state, and IP facets, then reports Alerts, Decisions, search, Dashboard, and facet p50/p95 latency separately over three runs. It also runs list pagination and advanced search concurrently with an uncached IP facet. Facet responses are checked for the 50-value hard bound.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOADTEST_BASE_URL` | `http://127.0.0.1:3133` | Backend benchmark target. |
| `LOADTEST_BENCHMARK_INSTANCE` | `default` | Instance used for scoped measurements; use `primary` with multi-instance profiles. |
| `LOADTEST_BENCHMARK_SAMPLES` | `5` | Samples collected per run. |
| `LOADTEST_ALERTS_BASELINE_P95_MS` | unset | Existing no-facet Alerts p95; when set, fail above a 10% regression. |
| `LOADTEST_SEARCH_BASELINE_P95_MS` | unset | Existing no-facet search p95; when set, fail above a 10% regression. |

Warm facets fail above 500ms, cold facets fail above two seconds, and list/search fail when one concurrent facet raises p95 by more than 25%. Set the two historical baseline variables to enforce the no-facet 10% regression gates. Compare Primary-only results, bootstrap logs, and process RSS with the existing 300k baseline; the script deliberately does not combine them into one score.

## Dataset Overrides

### Small dataset example

```bash
LOADTEST_ALERTS=1000 LOADTEST_DECISIONS=1000 ./run.sh loadtest
```

| Variable | Default profile value | Purpose |
| --- | --- | --- |
| `LOADTEST_PROFILE` | `default` | Container profile name. |
| `LOADTEST_ALERTS` | `300000` | Primary/default initial alerts. |
| `LOADTEST_DECISIONS` | `300000` | Primary/default initial decisions. |
| `LOADTEST_SEED` | `1337` | Deterministic generator seed. |
| `LOADTEST_DB_DIR` | `/tmp/crowdsec-web-ui-load-test` | Synthetic database directory. |
| `LOADTEST_BACKEND_PORT` | `3000` | Local load-test server port. |
| `LOADTEST_ACTIVE_DECISION_RATIO` | `0.7` | Fraction of generated decisions that are active. |
| `LOADTEST_SIMULATION_RATIO` | `0.1` | Fraction of generated simulated records. |
| `LOADTEST_DUPLICATE_VALUE_RATIO` | `0.15` | Fraction of duplicate decision values. |
| `LOADTEST_BLOCKLIST_DECISIONS` | `100000` | Decisions concentrated in one blocklist alert. |
| `LOADTEST_BLOCKLIST_SIZES` | Empty | Comma-separated blocklist sizes; overrides `LOADTEST_BLOCKLIST_DECISIONS`. |
| `LOADTEST_EMPTY_ALERTS` | `0` | Trailing alerts with no decisions. |
| `LOADTEST_EXPIRED_ALERTS` | `0` | Preceding decision-bearing alerts containing only expired decisions. |
| `LOADTEST_EXPIRING_SOON_DECISIONS` | `0` | Decisions expiring 5–15 minutes after the seed timestamp. |
| `LOADTEST_REFRESH_ALERTS` | `100` | Alerts added in each due head refresh. |
| `LOADTEST_REFRESH_DECISIONS` | `100` | Decisions added in each normal refresh. |
| `LOADTEST_REFRESH_DECISIONS_MIN_PER_ALERT` | `0` | Minimum decisions per refresh alert in blocklist mode. |
| `LOADTEST_REFRESH_DECISIONS_MAX_PER_ALERT` | `0` | Maximum decisions per refresh alert; values above zero enable blocklist mode. |
| `LOADTEST_REFRESH_DECISION_ORIGINS` | Empty (`mixed`) | Comma-separated origins used by refresh decisions. |
| `LOADTEST_MULTI_INSTANCE` | `false` | Enables Primary, Secondary, and Edge fake LAPIs. |
| `LOADTEST_FAILING_LAPI` | `false` | Makes Edge return failures in multi-instance mode. |
| `LOADTEST_SECONDARY_ALERTS` | `100000` | Secondary initial alerts when not set by a profile. |
| `LOADTEST_SECONDARY_DECISIONS` | `100000` | Secondary initial decisions when not set by a profile. |
| `LOADTEST_SECONDARY_BLOCKLIST_DECISIONS` | `25000` | Secondary concentrated blocklist size. |
| `LOADTEST_EDGE_ALERTS` | `25000` | Edge initial alerts when not set by a profile. |
| `LOADTEST_EDGE_DECISIONS` | `50000` | Edge initial decisions when not set by a profile. |
| `LOADTEST_EDGE_BLOCKLIST_DECISIONS` | `10000` | Edge concentrated blocklist size. |

### Application configuration

Application behavior uses the normal `CONFIG_*` variables.

- The default profile sets `CONFIG_AUTH_ENABLED=true`, `CONFIG_CROWDSEC_SYNC_LOOKBACK=30d`, `CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL=1m`, and `CONFIG_CROWDSEC_SIMULATIONS_ENABLED=true`.
- Explicit `CONFIG_*` values override profile defaults.
- OIDC uses the standard `CONFIG_AUTH_OIDC_*` variables, including indexed group arrays.

## Synthetic Refresh Behavior

- Initial and later records are exposed through the fake LAPI and imported by the normal synchronization code.
- `LOADTEST_BLOCKLIST_SIZES` accepts values such as `125000,100000,60000`; remaining decisions are distributed across other decision-bearing alerts.
- `LOADTEST_REFRESH_DECISIONS_MAX_PER_ALERT > 0` creates per-alert refresh blocklists with deterministic sizes between the configured minimum and maximum instead of using `LOADTEST_REFRESH_DECISIONS`.
- Refresh records are timestamped inside the authoritative delta window.
- Historical reconciliation requests never generate unrelated refresh batches.
- No decisions are generated when `LOADTEST_ALERTS=0`, because CrowdSec decisions are embedded in alert payloads.

## Containerized Load Test

The development workflow publishes `ghcr.io/theduffman85/crowdsec-web-ui:loadtest`. It is a drop-in replacement for the regular image: retain the ports, authentication environment, OIDC environment, and `/app/data` volume; change the tag and select a profile.

```yaml
services:
  crowdsec-web-ui:
    image: ghcr.io/theduffman85/crowdsec-web-ui:loadtest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      LOADTEST_PROFILE: blocklists-mixed
```

`LOADTEST_PROFILE` accepts `default`, `blocklist`, `blocklists-mixed`, `multi-instance`, or `multi-instance-medium`. Individual `LOADTEST_*` and `CONFIG_*` variables override profile defaults. CrowdSec connection settings are ignored.

### Database Safety

- Local mode defaults to `/tmp/crowdsec-web-ui-load-test`.
- The container ignores `CONFIG_STORAGE_DATA_DIR` and uses `LOADTEST_DB_DIR`, also defaulting to `/tmp/crowdsec-web-ui-load-test` inside the container.
- The synthetic database is recreated on every container start.
- The `/app/data` application database is never used for synthetic seeding, even when that directory is mounted.
