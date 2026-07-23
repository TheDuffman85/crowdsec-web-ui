<div align="center">
  <img src="client/public/logo.svg" alt="CrowdSec Web UI Logo" width="400" />
</div>

<div align="center">

  [![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/TheDuffman85/crowdsec-web-ui/release.yml?style=flat-square&logo=github&label=build)](https://github.com/TheDuffman85/crowdsec-web-ui/actions/workflows/release.yml)
  [![Trivy Scan](https://img.shields.io/github/actions/workflow/status/TheDuffman85/crowdsec-web-ui/trivy-scan.yml?style=flat-square&logo=aqua&label=security)](https://github.com/TheDuffman85/crowdsec-web-ui/actions/workflows/trivy-scan.yml)
  [![GitHub License](https://img.shields.io/github/license/TheDuffman85/crowdsec-web-ui?style=flat-square&logo=github)](https://github.com/TheDuffman85/crowdsec-web-ui/blob/main/LICENSE)
  [![GitHub last commit](https://img.shields.io/github/last-commit/TheDuffman85/crowdsec-web-ui?style=flat-square&logo=github)](https://github.com/TheDuffman85/crowdsec-web-ui/commits/main)
  [![Latest Container](https://img.shields.io/badge/ghcr.io-latest-blue?style=flat-square&logo=github)](https://github.com/users/TheDuffman85/packages/container/package/crowdsec-web-ui)

</div>

# CrowdSec Web UI

A self-hosted dashboard for [CrowdSec](https://crowdsec.net/): investigate alerts, manage decisions, monitor runtime metrics, and send notifications from one responsive UI.

<div align="center">
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/react-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB" alt="React" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/vite-%23646CFF.svg?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/tailwindcss-%2338B2AC.svg?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node.js-%23339933.svg?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" /></a>
</div>

## Features

| Area | Highlights |
| --- | --- |
| Dashboard | Alert and active-decision totals, attack map, drilldowns, top lists, filters, and simulation counts |
| Alerts | Searchable alert history and CrowdSec alert contexts, IP/AS/location details, event metadata, simulation labels, and configurable columns |
| Decisions | Active and expired decisions, duplicate hiding, manual bans, custom durations, reasons, and cleanup actions |
| Multi-instance | Several CrowdSec LAPIs, per-instance views, and a Combined scope for Dashboard, Alerts, and Decisions |
| Metrics | Optional Prometheus views for LAPI activity, bouncers, AppSec, parsers, latency, parsing time, and whitelists |
| Notifications | Alert, decision, CVE, availability, and update rules delivered through Email, Gotify, MQTT, ntfy, or Webhooks |
| Security | Initial administrator setup, password and TOTP login, passkeys, OIDC SSO, group roles, and instance-wide read-only mode |
| Localization | Arabic, Chinese, English, French, German, Hindi, Japanese, Portuguese, Russian, and Spanish |
| Experience | Unified search, dark/light themes, and responsive layouts |

### Screenshots

<p>
  <a href="screenshots/dashboard.png"><img src="screenshots/dashboard.png" alt="Dashboard" width="48%"></a>
  <a href="screenshots/multi_instance.png"><img src="screenshots/multi_instance.png" alt="Combined multi-instance alerts" width="48%"></a>
</p>
<p>
  <a href="screenshots/alerts.png"><img src="screenshots/alerts.png" alt="Alerts" width="48%"></a>
  <a href="screenshots/alert_details.png"><img src="screenshots/alert_details.png" alt="Alert Details" width="48%"></a>
</p>
<p>
  <a href="screenshots/search_syntax.png"><img src="screenshots/search_syntax.png" alt="Search Syntax" width="48%"></a>
  <a href="screenshots/decisions.png"><img src="screenshots/decisions.png" alt="Decisions" width="48%"></a>
</p>
<p>
  <a href="screenshots/add_decision.png"><img src="screenshots/add_decision.png" alt="Add Decision" width="48%"></a>
  <a href="screenshots/notifications.png"><img src="screenshots/notifications.png" alt="Notification Center" width="48%"></a>
</p>
<p>
  <a href="screenshots/notification_rule.png"><img src="screenshots/notification_rule.png" alt="Notification Rule" width="48%"></a>
  <a href="screenshots/metrics.png"><img src="screenshots/metrics.png" alt="Runtime Metrics" width="48%"></a>
</p>
<p>
  <a href="screenshots/settings.png"><img src="screenshots/settings.png" alt="Settings" width="48%"></a>
</p>

## Quick Start

You need a running CrowdSec LAPI. Connect the Web UI using either watcher password authentication or agent mTLS.

### 1. Register the Web UI

#### Watcher password

```bash
openssl rand -hex 32
docker exec crowdsec cscli machines add crowdsec-web-ui --password 'replace-with-generated-password' -f /dev/null
```

Replace `replace-with-generated-password` with the value printed by `openssl`.

> [!IMPORTANT]
> Keep `-f /dev/null`. It registers the machine without overwriting the CrowdSec container's existing credentials file.

#### Agent mTLS

Configure LAPI TLS authentication and create a client certificate/key pair using the [CrowdSec TLS authentication guide](https://docs.crowdsec.net/docs/local_api/tls_auth/).

### 2. Start with Docker Compose

```yaml
services:
  crowdsec-web-ui:
    image: ghcr.io/theduffman85/crowdsec-web-ui:latest
    container_name: crowdsec_web_ui
    ports:
      - "3000:3000"
    environment:
      CONFIG_INSTANCE_LAPI_URL: http://crowdsec:8080
      CONFIG_INSTANCE_LAPI_AUTH_USERNAME: crowdsec-web-ui
      CONFIG_INSTANCE_LAPI_AUTH_PASSWORD: your-crowdsec-password
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

A ready-to-use [`docker-compose.yml`](docker-compose.yml) is included. Add the generated password, make sure the Web UI can reach CrowdSec on the same Docker network, then start it.

```bash
docker compose up -d
```

Open `http://localhost:3000` and create the initial administrator account.

### Docker Run Alternative

```bash
docker pull ghcr.io/theduffman85/crowdsec-web-ui:latest
mkdir -p data
docker run -d \
  --name crowdsec_web_ui \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e CONFIG_INSTANCE_LAPI_URL=http://crowdsec:8080 \
  -e CONFIG_INSTANCE_LAPI_AUTH_USERNAME=crowdsec-web-ui \
  -e CONFIG_INSTANCE_LAPI_AUTH_PASSWORD=your-crowdsec-password \
  --network your_crowdsec_network \
  ghcr.io/theduffman85/crowdsec-web-ui:latest
```

Current images use Node.js and do not have the former Bun/AVX-specific x64 limitation.

### mTLS Compose Alternative

```yaml
services:
  crowdsec-web-ui:
    image: ghcr.io/theduffman85/crowdsec-web-ui:latest
    container_name: crowdsec_web_ui
    ports:
      - "3000:3000"
    environment:
      CONFIG_INSTANCE_LAPI_URL: https://crowdsec:8080
      CONFIG_INSTANCE_LAPI_AUTH_TYPE: mtls
      CONFIG_INSTANCE_LAPI_AUTH_CERT_FILE: /certs/agent.pem
      CONFIG_INSTANCE_LAPI_AUTH_KEY_FILE: /certs/agent-key.pem
      # CONFIG_INSTANCE_LAPI_TLS_CA_FILE: /certs/ca.pem
    volumes:
      - ./data:/app/data
      - /path/on/host/agent.pem:/certs/agent.pem:ro
      - /path/on/host/agent-key.pem:/certs/agent-key.pem:ro
      # - /path/on/host/ca.pem:/certs/ca.pem:ro
    restart: unless-stopped
```

Adjust the URL and certificate paths. Enable `CONFIG_INSTANCE_LAPI_TLS_CA_FILE` and its volume when LAPI uses a private CA.

> [!CAUTION]
> Use HTTPS and a hardened reverse proxy for public deployments. Built-in authentication protects the UI and API, but TLS terminates outside the application. OIDC integrations include [Authentik](https://goauthentik.io/), [Authelia](https://www.authelia.com/), and [Keycloak](https://www.keycloak.org/). Migrated installations that predate authentication remain unauthenticated until explicitly enabled.

## Architecture

| Component | Implementation |
| --- | --- |
| Client | React, Vite, and Tailwind CSS; builds to `dist/client` |
| Server | Node.js and Hono; builds to `dist/server` |
| Storage | SQLite via `better-sqlite3` under `/app/data` |
| CrowdSec | Watcher password or agent mTLS; delta refreshes and chunked historical synchronization |
| Container | Runs as the non-root `node` user |

## Configuration

### Configuration files

| Environment | Default path |
| --- | --- |
| Docker | `/app/data/config.yaml` |
| Local | `./data/config.yaml` |

Use `CONFIG_FILE` only to select another existing file. [`config.example.yaml`](config.example.yaml) contains the complete commented YAML reference.

### Configuration lifecycle

| Stage | Behavior |
| --- | --- |
| First start | Creates the missing default file. Supplied values become active YAML; defaults and optional examples remain comments. Generated mappings use block rows and the documented order. |
| Later starts | Treats the file as user-managed. `CONFIG_*` values override it in memory without rewriting it; generated explanations and defaults are not refreshed. |
| Persistent overrides | `CONFIG_PERSIST_OVERRIDES: "true"` writes validated merged values while preserving comments where possible. Removing a persisted non-secret override leaves its last value in YAML. |
| Precedence | Applies section variables, then field variables, then indexed array variables. Removing a non-persisted override reveals the file value. |
| Logging | Records applied paths and before/after values. Credentials are redacted; secret references show only their environment name or file path. |
| Reloading | Requires a restart after configuration changes or secret rotation. |

### Environment overrides

- Values are parsed as YAML and validated.
- Arrays use zero-based contiguous indexes: `CONFIG_AUTH_OIDC_ADMIN_GROUPS_0`, `CONFIG_INSTANCES_0_ID`, `CONFIG_INSTANCES_0_METRICS_0_URL`.
- Whole sections accept YAML through `CONFIG_SERVER`, `CONFIG_STORAGE`, `CONFIG_UI`, `CONFIG_AUTH`, `CONFIG_NOTIFICATIONS`, `CONFIG_UPDATES`, `CONFIG_CROWDSEC`, or `CONFIG_INSTANCES`.
- `CONFIG_INSTANCE_*` addresses instance `0`: `CONFIG_INSTANCE_NAME` equals `CONFIG_INSTANCES_0_NAME`. Metrics index `0` may also be omitted: `CONFIG_INSTANCES_0_METRICS_URL` equals `CONFIG_INSTANCES_0_METRICS_0_URL`, and `CONFIG_INSTANCE_METRICS_URL` applies both shorthands. Do not set equivalent forms together.
- Secrets accept a direct string or exactly one `env: NAME` / `file: PATH` reference. Secret overrides also accept `_FILE`.
- Initial direct secret overrides are stored as environment references, never plaintext. Persisted secret references still require their environment variable.

### Server, storage, UI, and updates

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `server.port` | `3000` | HTTP listen port. | `CONFIG_SERVER_PORT` |
| `server.basePath` | `""` | Optional URL prefix such as `/crowdsec`; no trailing slash. | `CONFIG_SERVER_BASE_PATH` |
| `storage.dataDir` | `/app/data` | SQLite database and persistent application state. | `CONFIG_STORAGE_DATA_DIR` |
| `storage.geonamesDir` | `/app/geonames` in Docker; `./geonames` locally | Local GeoNames snapshot used for location labels. | `CONFIG_STORAGE_GEONAMES_DIR` |
| `storage.walEnabled` | `true` | Enables SQLite write-ahead logging. Set to `false` for filesystems that do not support WAL. | `CONFIG_STORAGE_WAL_ENABLED` |
| `ui.timeZone` | `browser` | Browser timezone or an IANA zone such as `Europe/Berlin` or `UTC`. | `CONFIG_UI_TIME_ZONE` |
| `ui.timeFormat` | `browser` | Clock format: `browser`, `12h`, or `24h`. | `CONFIG_UI_TIME_FORMAT` |
| `ui.readOnly` | `false` | Hides management actions and rejects mutating API operations. | `CONFIG_UI_READ_ONLY` |
| `updates.enabled` | `true` in packaged images | Enables the built-in update check. | `CONFIG_UPDATES_ENABLED` |

### Authentication

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `auth.enabled` | `auto` | Enables authentication; `auto` enables new databases while preserving migrated database state. | `CONFIG_AUTH_ENABLED` |
| `auth.sessionSecret` | Generated and stored | Signs sessions and encrypts saved authentication settings. | `CONFIG_AUTH_SESSION_SECRET` or `CONFIG_AUTH_SESSION_SECRET_FILE` |
| `auth.totpSecret` | `sessionSecret` | Encrypts stored per-account TOTP seeds. | `CONFIG_AUTH_TOTP_SECRET` or `CONFIG_AUTH_TOTP_SECRET_FILE` |
| `auth.totpSeed` | Unset | Optional base32 fallback TOTP seed for the password user; minimum 26 characters. | `CONFIG_AUTH_TOTP_SEED` or `CONFIG_AUTH_TOTP_SEED_FILE` |
| `auth.oidc.issuerUrl` | Unset | OIDC provider issuer URL. | `CONFIG_AUTH_OIDC_ISSUER_URL` |
| `auth.oidc.clientId` | Unset | OIDC client identifier. | `CONFIG_AUTH_OIDC_CLIENT_ID` |
| `auth.oidc.clientSecret` | Unset | OIDC client secret. | `CONFIG_AUTH_OIDC_CLIENT_SECRET` or `CONFIG_AUTH_OIDC_CLIENT_SECRET_FILE` |
| `auth.oidc.scope` | `openid profile email` | Requested OIDC scopes; must include `openid`. | `CONFIG_AUTH_OIDC_SCOPE` |
| `auth.oidc.groupsClaim` | `groups` | Claim containing role-mapping groups. | `CONFIG_AUTH_OIDC_GROUPS_CLAIM` |
| `auth.oidc.adminGroups` | `[]` | Groups granted administrator access. | `CONFIG_AUTH_OIDC_ADMIN_GROUPS` or `CONFIG_AUTH_OIDC_ADMIN_GROUPS_<INDEX>` |
| `auth.oidc.readOnlyGroups` | `[]` | Groups granted read-only access. | `CONFIG_AUTH_OIDC_READ_ONLY_GROUPS` or `CONFIG_AUTH_OIDC_READ_ONLY_GROUPS_<INDEX>` |
| `auth.oidc.unmatchedRole` | `deny` | Role for unmatched OIDC users: `deny`, `admin`, or `read-only`. | `CONFIG_AUTH_OIDC_UNMATCHED_ROLE` |

### Notifications

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `notifications.secretKey` | Generated and stored | Encrypts saved notification credentials. | `CONFIG_NOTIFICATIONS_SECRET_KEY` or `CONFIG_NOTIFICATIONS_SECRET_KEY_FILE` |
| `notifications.allowPrivateAddresses` | `true` | Allows private, loopback, and link-local notification destinations. | `CONFIG_NOTIFICATIONS_ALLOW_PRIVATE_ADDRESSES` |
| `notifications.debugPayloads` | `false` | Logs truncated rendered payloads after failed notification delivery. | `CONFIG_NOTIFICATIONS_DEBUG_PAYLOADS` |

### Alert handling

Omitting `crowdsec.alertFilters` uses the standard non-CAPI feed. Setting any explicit filter field enables explicit filtering.

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `crowdsec.simulationsEnabled` | `false` | Includes simulation-mode alerts and decisions. | `CONFIG_CROWDSEC_SIMULATIONS_ENABLED` |
| `crowdsec.alertFilters.includeOrigins` | `[]` | Keeps alerts matching these exact origins. | `CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_ORIGINS` or `CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_ORIGINS_<INDEX>` |
| `crowdsec.alertFilters.excludeOrigins` | `[]` | Drops alerts matching these exact origins. | `CONFIG_CROWDSEC_ALERT_FILTERS_EXCLUDE_ORIGINS` or `CONFIG_CROWDSEC_ALERT_FILTERS_EXCLUDE_ORIGINS_<INDEX>` |
| `crowdsec.alertFilters.includeCapi` | `false` | Adds the Central API/community-blocklist feed. | `CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_CAPI` |
| `crowdsec.alertFilters.includeOriginEmpty` | `false` | Keeps empty-origin alerts with explicit include filters. | `CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_ORIGIN_EMPTY` |
| `crowdsec.alertFilters.excludeOriginEmpty` | `false` | Drops alerts whose effective origin is empty. | `CONFIG_CROWDSEC_ALERT_FILTERS_EXCLUDE_ORIGIN_EMPTY` |
| `crowdsec.alertFilters.legacy.origins` | `[]` | Compatibility origin allowlist; `CAPI` enables the CAPI feed. | `CONFIG_CROWDSEC_ALERT_FILTERS_LEGACY_ORIGINS` or `CONFIG_CROWDSEC_ALERT_FILTERS_LEGACY_ORIGINS_<INDEX>` |
| `crowdsec.alertFilters.legacy.extraScenarios` | `[]` | Compatibility list of additional scenarios. | `CONFIG_CROWDSEC_ALERT_FILTERS_LEGACY_EXTRA_SCENARIOS` or `CONFIG_CROWDSEC_ALERT_FILTERS_LEGACY_EXTRA_SCENARIOS_<INDEX>` |

### Global synchronization

Synchronization durations accept `ms`, `s`, `m`, `h`, or `d`, for example `500ms`, `30s`, `5m`, or `7d`. The `lookback` fields accept only `m`, `h`, or `d`.

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `crowdsec.sync.lookback` | `168h` | Imported history and retention window. | `CONFIG_CROWDSEC_SYNC_LOOKBACK` |
| `crowdsec.sync.refreshInterval` | `1m` | Active refresh cadence; `0` or `manual` disables scheduling. | `CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL` |
| `crowdsec.sync.manualRefreshEnabled` | `false` | Enables manual refresh controls. | `CONFIG_CROWDSEC_SYNC_MANUAL_REFRESH_ENABLED` |
| `crowdsec.sync.idleRefreshInterval` | `10m` | Refresh cadence while the application is idle; `0` disables it. | `CONFIG_CROWDSEC_SYNC_IDLE_REFRESH_INTERVAL` |
| `crowdsec.sync.idleThreshold` | `2m` | Inactivity before idle refresh behavior begins. | `CONFIG_CROWDSEC_SYNC_IDLE_THRESHOLD` |
| `crowdsec.sync.requestTimeout` | `30s` | Timeout for individual LAPI requests. | `CONFIG_CROWDSEC_SYNC_REQUEST_TIMEOUT` |
| `crowdsec.sync.bouncerPropagationDelay` | `15s` | Grace period before deleting alerts owned by expired decisions. | `CONFIG_CROWDSEC_SYNC_BOUNCER_PROPAGATION_DELAY` |
| `crowdsec.sync.metricsRequestTimeout` | `5s` | Default timeout for metrics endpoints. | `CONFIG_CROWDSEC_SYNC_METRICS_REQUEST_TIMEOUT` |
| `crowdsec.sync.heartbeatInterval` | `30s` | CrowdSec machine heartbeat cadence; `0` disables it. | `CONFIG_CROWDSEC_SYNC_HEARTBEAT_INTERVAL` |
| `crowdsec.sync.alertSyncChunk` | `12h` | Historical import window size. | `CONFIG_CROWDSEC_SYNC_ALERT_SYNC_CHUNK` |
| `crowdsec.sync.alertSyncMinChunk` | `15m` | Minimum retry window after a timed-out import. | `CONFIG_CROWDSEC_SYNC_ALERT_SYNC_MIN_CHUNK` |
| `crowdsec.sync.reconcileWindow` | `1h` | Fixed alert-history reconciliation window size. | `CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOW` |
| `crowdsec.sync.reconcileRecentAge` | `24h` | Boundary between recent and older windows. | `CONFIG_CROWDSEC_SYNC_RECONCILE_RECENT_AGE` |
| `crowdsec.sync.reconcileRecentInterval` | `15m` | Reconciliation cadence for recent windows. | `CONFIG_CROWDSEC_SYNC_RECONCILE_RECENT_INTERVAL` |
| `crowdsec.sync.reconcileActiveInterval` | `5m` | Reconciliation cadence for windows with active decisions. | `CONFIG_CROWDSEC_SYNC_RECONCILE_ACTIVE_INTERVAL` |
| `crowdsec.sync.reconcileOldInterval` | `3h` | Reconciliation cadence for older windows. | `CONFIG_CROWDSEC_SYNC_RECONCILE_OLD_INTERVAL` |
| `crowdsec.sync.reconcileWindowsPerRefresh` | `2` | Maximum due windows processed per refresh. | `CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOWS_PER_REFRESH` |
| `crowdsec.sync.bootstrapRetryDelay` | `30s` | Delay between failed initial-sync retries; `0` retries immediately. | `CONFIG_CROWDSEC_SYNC_BOOTSTRAP_RETRY_DELAY` |
| `crowdsec.sync.bootstrapRetryEnabled` | `true` | Enables background retry after initial synchronization failure. | `CONFIG_CROWDSEC_SYNC_BOOTSTRAP_RETRY_ENABLED` |

### Instances and LAPI

- `<INDEX>` is zero-based.
- ID defaults to the index; name defaults to `Instance <INDEX>`; authentication type is inferred from credentials.
- Inferred values appear as comments in initial YAML unless compatibility requires an explicit identity.
- Explicit IDs use lowercase letters, digits, `_`, and `-`. Keep them stable after importing data.

> [!IMPORTANT]
> Configure exactly one credential shape:
> - Password auth: set `username` and `password`
> - mTLS auth: set `certFile` and `keyFile`
>
> `type` is optional and inferred from these fields. Set it explicitly to `none`, `password`, or `mtls` when desired. Do not mix password and mTLS credentials.
>
> Plaintext secrets are supported, but mounted secret files are recommended so credentials do not end up in source control, backups, or configuration-management logs.

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `instances` | One generated `default` instance | Configures one or more CrowdSec connections. | `CONFIG_INSTANCES` or `CONFIG_INSTANCES_<INDEX>_*` |
| `instances[].id` | Zero-based instance index | Stable database identity for the instance. | `CONFIG_INSTANCES_<INDEX>_ID` |
| `instances[].name` | `Instance <INDEX>` | Unique display name. | `CONFIG_INSTANCES_<INDEX>_NAME` |
| `instances[].icon` | Unset | Optional short text or emoji shown in the selector. | `CONFIG_INSTANCES_<INDEX>_ICON` |
| `instances[].lapi` | Required | Complete LAPI connection object. | `CONFIG_INSTANCES_<INDEX>_LAPI` |
| `instances[].lapi.url` | Required (`http://crowdsec:8080` in starter config) | Absolute HTTP(S) LAPI base URL without credentials, a path, or a fragment. | `CONFIG_INSTANCES_<INDEX>_LAPI_URL` |
| `instances[].lapi.auth` | `type: none` | LAPI authentication object. | `CONFIG_INSTANCES_<INDEX>_LAPI_AUTH` |
| `instances[].lapi.auth.type` | Inferred from credentials | Optional authentication mode: `none`, `password`, or `mtls`. | `CONFIG_INSTANCES_<INDEX>_LAPI_AUTH_TYPE` |
| `instances[].lapi.auth.username` | Required for `password` | CrowdSec machine username. | `CONFIG_INSTANCES_<INDEX>_LAPI_AUTH_USERNAME` |
| `instances[].lapi.auth.password` | Required for `password` | CrowdSec machine password or secret reference. | `CONFIG_INSTANCES_<INDEX>_LAPI_AUTH_PASSWORD` or `CONFIG_INSTANCES_<INDEX>_LAPI_AUTH_PASSWORD_FILE` |
| `instances[].lapi.auth.certFile` | Required for `mtls` | Client certificate path. | `CONFIG_INSTANCES_<INDEX>_LAPI_AUTH_CERT_FILE` |
| `instances[].lapi.auth.keyFile` | Required for `mtls` | Client private-key path. | `CONFIG_INSTANCES_<INDEX>_LAPI_AUTH_KEY_FILE` |
| `instances[].lapi.tls` | Empty mapping | LAPI server-trust settings. | `CONFIG_INSTANCES_<INDEX>_LAPI_TLS` |
| `instances[].lapi.tls.caFile` | Unset | CA bundle used to verify the LAPI server. | `CONFIG_INSTANCES_<INDEX>_LAPI_TLS_CA_FILE` |
| `instances[].metrics` | `[]` | Zero or more metrics endpoints. | `CONFIG_INSTANCES_<INDEX>_METRICS` or `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_*` |
| `instances[].sync` | Inherits global values | Per-instance synchronization overrides. | `CONFIG_INSTANCES_<INDEX>_SYNC` or `CONFIG_INSTANCES_<INDEX>_SYNC_*` |

### Metrics endpoints

- `<INDEX>` selects the instance; zero-based `<METRIC_INDEX>` selects its endpoint.
- Endpoint ID defaults to `<METRIC_INDEX>` and name to `Metrics <METRIC_INDEX>`.
- Inferred values appear as comments in initial YAML.

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `instances[].metrics[].id` | Zero-based metrics index | Stable identifier unique within the instance. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_ID` |
| `instances[].metrics[].name` | `Metrics <METRIC_INDEX>` | Display name. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_NAME` |
| `instances[].metrics[].url` | Required | Absolute HTTP(S) Prometheus endpoint URL. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_URL` |
| `instances[].metrics[].requestTimeout` | Global `5s` | Request timeout for this endpoint. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_REQUEST_TIMEOUT` |
| `instances[].metrics[].auth` | `type: none` | Complete metrics authentication object. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_AUTH` |
| `instances[].metrics[].auth.type` | Inferred from credentials | Optional authentication mode: `none`, `basic`, or `bearer`. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_AUTH_TYPE` |
| `instances[].metrics[].auth.username` | Required for `basic` | Basic-auth username. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_AUTH_USERNAME` |
| `instances[].metrics[].auth.password` | Required for `basic` | Basic-auth password or secret reference. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_AUTH_PASSWORD` or `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_AUTH_PASSWORD_FILE` |
| `instances[].metrics[].auth.token` | Required for `bearer` | Bearer token or secret reference. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_AUTH_TOKEN` or `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_AUTH_TOKEN_FILE` |
| `instances[].metrics[].tls` | Empty mapping | Metrics TLS settings. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_TLS` |
| `instances[].metrics[].tls.caFile` | Unset | CA bundle used to verify the metrics server. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_TLS_CA_FILE` |
| `instances[].metrics[].tls.certFile` | Unset | Optional metrics client certificate; requires `keyFile`. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_TLS_CERT_FILE` |
| `instances[].metrics[].tls.keyFile` | Unset | Optional metrics client private key; requires `certFile`. | `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_TLS_KEY_FILE` |

### Per-instance synchronization overrides

Every field inherits its corresponding global value when omitted.

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `instances[].sync.lookback` | Global `168h` | History and retention window for this instance. | `CONFIG_INSTANCES_<INDEX>_SYNC_LOOKBACK` |
| `instances[].sync.refreshInterval` | Global `1m` | Active refresh cadence. | `CONFIG_INSTANCES_<INDEX>_SYNC_REFRESH_INTERVAL` |
| `instances[].sync.idleRefreshInterval` | Global `10m` | Idle refresh cadence. | `CONFIG_INSTANCES_<INDEX>_SYNC_IDLE_REFRESH_INTERVAL` |
| `instances[].sync.idleThreshold` | Global `2m` | Time before this instance is considered idle. | `CONFIG_INSTANCES_<INDEX>_SYNC_IDLE_THRESHOLD` |
| `instances[].sync.requestTimeout` | Global `30s` | LAPI request timeout. | `CONFIG_INSTANCES_<INDEX>_SYNC_REQUEST_TIMEOUT` |
| `instances[].sync.heartbeatInterval` | Global `30s` | Machine heartbeat cadence. | `CONFIG_INSTANCES_<INDEX>_SYNC_HEARTBEAT_INTERVAL` |
| `instances[].sync.alertSyncChunk` | Global `12h` | Historical import window size. | `CONFIG_INSTANCES_<INDEX>_SYNC_ALERT_SYNC_CHUNK` |
| `instances[].sync.alertSyncMinChunk` | Global `15m` | Minimum retry window. | `CONFIG_INSTANCES_<INDEX>_SYNC_ALERT_SYNC_MIN_CHUNK` |
| `instances[].sync.reconcileWindow` | Global `1h` | Reconciliation window size. | `CONFIG_INSTANCES_<INDEX>_SYNC_RECONCILE_WINDOW` |
| `instances[].sync.reconcileRecentAge` | Global `24h` | Recent-window age boundary. | `CONFIG_INSTANCES_<INDEX>_SYNC_RECONCILE_RECENT_AGE` |
| `instances[].sync.reconcileRecentInterval` | Global `15m` | Recent-window reconciliation cadence. | `CONFIG_INSTANCES_<INDEX>_SYNC_RECONCILE_RECENT_INTERVAL` |
| `instances[].sync.reconcileActiveInterval` | Global `5m` | Active-decision reconciliation cadence. | `CONFIG_INSTANCES_<INDEX>_SYNC_RECONCILE_ACTIVE_INTERVAL` |
| `instances[].sync.reconcileOldInterval` | Global `3h` | Older-window reconciliation cadence. | `CONFIG_INSTANCES_<INDEX>_SYNC_RECONCILE_OLD_INTERVAL` |
| `instances[].sync.reconcileWindowsPerRefresh` | Global `2` | Due-window budget per refresh. | `CONFIG_INSTANCES_<INDEX>_SYNC_RECONCILE_WINDOWS_PER_REFRESH` |
| `instances[].sync.bootstrapRetryDelay` | Global `30s` | Initial-sync retry delay. | `CONFIG_INSTANCES_<INDEX>_SYNC_BOOTSTRAP_RETRY_DELAY` |
| `instances[].sync.bootstrapRetryEnabled` | Global `true` | Enables background initial-sync retry. | `CONFIG_INSTANCES_<INDEX>_SYNC_BOOTSTRAP_RETRY_ENABLED` |
| `instances[].sync.bouncerPropagationDelay` | Global `15s` | Alert-deletion grace period. | `CONFIG_INSTANCES_<INDEX>_SYNC_BOUNCER_PROPAGATION_DELAY` |

## Multiple CrowdSec instances

Use zero-based `CONFIG_INSTANCES_<INDEX>_*` overrides to define each instance. Indexes must be contiguous, starting at `0`.

```yaml
services:
  crowdsec-web-ui:
    image: ghcr.io/theduffman85/crowdsec-web-ui:latest
    environment:
      CONFIG_INSTANCES_0_ID: eu-prod
      CONFIG_INSTANCES_0_NAME: EU Production
      CONFIG_INSTANCES_0_LAPI_URL: http://crowdsec-eu:8080
      CONFIG_INSTANCES_0_LAPI_AUTH_USERNAME: crowdsec-web-ui
      CONFIG_INSTANCES_0_LAPI_AUTH_PASSWORD_FILE: /run/secrets/eu-lapi-password
      CONFIG_INSTANCES_0_METRICS_0_ID: lapi
      CONFIG_INSTANCES_0_METRICS_0_NAME: EU LAPI
      CONFIG_INSTANCES_0_METRICS_0_URL: http://crowdsec-eu:6060/metrics

      CONFIG_INSTANCES_1_ID: us-prod
      CONFIG_INSTANCES_1_NAME: US Production
      CONFIG_INSTANCES_1_LAPI_URL: http://crowdsec-us:8080
      CONFIG_INSTANCES_1_LAPI_AUTH_USERNAME: crowdsec-web-ui
      CONFIG_INSTANCES_1_LAPI_AUTH_PASSWORD_FILE: /run/secrets/us-lapi-password

      # For mTLS, replace instance 1's URL and password credentials above with:
      # CONFIG_INSTANCES_1_LAPI_URL: https://crowdsec-us:8080
      # CONFIG_INSTANCES_1_LAPI_AUTH_TYPE: mtls
      # CONFIG_INSTANCES_1_LAPI_AUTH_CERT_FILE: /certs/us-client-cert.pem
      # CONFIG_INSTANCES_1_LAPI_AUTH_KEY_FILE: /run/secrets/us-client-key.pem
      # CONFIG_INSTANCES_1_LAPI_TLS_CA_FILE: /certs/us-ca.pem
    volumes:
      - ./secrets/eu-lapi-password:/run/secrets/eu-lapi-password:ro
      - ./secrets/us-lapi-password:/run/secrets/us-lapi-password:ro
      # Mount these files when using the commented mTLS configuration:
      # - ./certs/us-client-cert.pem:/certs/us-client-cert.pem:ro
      # - ./secrets/us-client-key.pem:/run/secrets/us-client-key.pem:ro
      # - ./certs/us-ca.pem:/certs/us-ca.pem:ro
```

- Use indexed variables for every instance in a multi-instance setup; reserve the `CONFIG_INSTANCE_*` shorthand for single-instance deployments.
- Each instance needs a stable ID, unique display name, LAPI URL, and one authentication method.
- Add metrics endpoints with `CONFIG_INSTANCES_<INDEX>_METRICS_<METRIC_INDEX>_*`.
- Mount password files read-only. When using the optional mTLS configuration, mount its private keys and certificates read-only as well, then restart the container.

### YAML alternative

Add entries to the top-level `instances` array. Each entry defines one LAPI connection and zero or more metrics endpoints.

```yaml
instances:
  - id: eu-prod
    name: EU Production
    icon: 🇪🇺
    lapi:
      url: http://crowdsec-eu:8080
      auth:
        type: password
        username: crowdsec-web-ui
        password:
          file: /run/secrets/eu-lapi-password

    metrics:
      - id: lapi
        name: EU LAPI
        url: http://crowdsec-eu:6060/metrics
        auth:
          type: bearer
          token:
            file: /run/secrets/eu-metrics-token

      - id: edge-engine
        name: EU Edge Engine
        url: http://crowdsec-edge:6060/metrics

    sync:
      requestTimeout: 45s
      alertSyncChunk: 6h

  - id: us-prod
    name: US Production
    icon: 🇺🇸
    lapi:
      url: http://crowdsec-us:8080
      auth:
        type: password
        username: crowdsec-web-ui
        password:
          file: /run/secrets/us-lapi-password
      # For mTLS, replace url and auth above with:
      # url: https://crowdsec-us:8080
      # auth:
      #   type: mtls
      #   certFile: /run/secrets/us-client-cert
      #   keyFile: /run/secrets/us-client-key
      # tls:
      #   caFile: /run/secrets/us-ca
```

### Configuration rules

- Instance and endpoint IDs are unique, URL-safe, and immutable database identities. They are 1–63 characters long, start with a lowercase letter or digit, use only lowercase letters, digits, `_`, or `-`, and must never be reused for another LAPI.
- Display names are unique but editable. `icon` accepts up to eight Unicode code points of text or emoji without control characters; omitted icons use colored squares and Combined uses a grid.
- Password secrets accept a direct value or exactly one `env`/`file` source. mTLS requires both `certFile` and `keyFile`; `tls.caFile` controls server trust.
- Metrics authentication supports `none`, `basic`, and `bearer`; metrics TLS supports `caFile` plus an optional complete client certificate/key pair.
- Embedded URL credentials, URL fragments, ambiguous secret sources, partial certificate pairs, unreadable files, and TLS verification bypasses fail validation. LAPI base URLs also reject paths.
- Prefer mounted secret files. Restart after configuration, certificate, or secret changes.

### Multi-instance behavior

| Area | Behavior |
| --- | --- |
| Dashboard, Alerts, Decisions | Support one instance or Combined scope |
| Metrics | Always uses one instance and endpoint; process-local counters are not summed |
| Add decision / clean IP | Runs against every LAPI in Combined scope and reports partial failures |
| Row deletion | Uses the row's owning instance; numeric upstream IDs are never broadcast |

## Authentication

Authentication covers the browser UI and protected APIs; `/api/health` remains public.

| `auth.enabled` | Behavior |
| --- | --- |
| `auto` | Enables authentication for new databases; preserves the state of migrated databases |
| `true` | Requires authentication and initial administrator setup |
| `false` | Disables authentication; this deployment setting is not available in the UI |

### Upgraded installations

Enable authentication explicitly on installations migrated from older releases.

```yaml
auth:
  enabled: true
```

### Local accounts

- Password changes and passkey registration/removal from Settings.
- Optional TOTP enrollment through a QR code, mobile setup link, or manual key.
- An enrolled TOTP seed overrides the optional base32 `auth.totpSeed` fallback.
- Administrators can disable password login.

### OIDC

Configure OIDC in Settings or YAML.

```yaml
auth:
  enabled: true
  oidc:
    issuerUrl: https://idp.example.com/application/o/crowdsec-web-ui/
    clientId: crowdsec-web-ui
    clientSecret:
      file: /run/secrets/oidc_client_secret
    scope: openid profile email
    groupsClaim: groups
    adminGroups: [crowdsec-admins, secops]
    readOnlyGroups: [crowdsec-viewers]
    unmatchedRole: deny
```

#### Callback URL

Register this callback URI with the identity provider.

```text
https://<crowdsec-web-ui-host>/api/auth/oidc/callback
```

#### Requirements and roles

- The callback must exactly match the public scheme, host, port, and base path. For `basePath: /crowdsec`, use `https://<host>/crowdsec/api/auth/oidc/callback`.
- Reverse proxies must forward `Host` or `X-Forwarded-Host` and `X-Forwarded-Proto`.
- Saved Settings override YAML. Scopes must include `openid`; add provider-specific scopes such as `groups` only when required.
- Admin-group matches have full access; read-only-group matches can view data and keep permitted preferences; unmatched users follow `auth.oidc.unmatchedRole` (`deny` by default).
- Set an unmatched fallback role only when every user who can sign in should receive it.
- `ui.readOnly: true` overrides all roles for the deployment. It blocks CrowdSec writes, refresh changes, notification destination/rule management, test sends, and notification deletion. Language changes and marking notifications read remain available. This is not per-user RBAC.
- Identities use stable issuer and subject claims. Username collisions with local accounts remain separate.
- Sessions have a 24-hour absolute lifetime. OIDC-only users cannot add local passkeys; password-backed local accounts retain passkey support.
- Existing OIDC rows migrate on their next successful SSO login.

## Deployment and Security

### Trusted IPs for Delete Operations (Optional)

If delete operations return `403 Forbidden`, add the Web UI network to CrowdSec's trusted IPs in `/etc/crowdsec/config.yaml`.

```yaml
api:
  server:
    trusted_ips:
      - 127.0.0.1
      - ::1
      - 172.16.0.0/12  # Docker default bridge network
```

Restart CrowdSec after updating the file. The current CrowdSec container does not provide a `TRUSTED_IPS` environment override. See the [CrowdSec configuration reference](https://docs.crowdsec.net/docs/configuration/crowdsec_configuration/).

### Local or Custom LAPI Certificate

A self-signed certificate or internal CA may produce the following error.

```
Login failed: unable to get local issuer certificate
```

Mount the CA certificate and configure it for the LAPI instance.

```yaml
services:
  crowdsec-web-ui:
    image: ghcr.io/theduffman85/crowdsec-web-ui:latest
    container_name: crowdsec_web_ui
    ports:
      - "3000:3000"
    environment:
      CONFIG_INSTANCE_LAPI_URL: https://crowdsec:8080
      CONFIG_INSTANCE_LAPI_AUTH_USERNAME: crowdsec-web-ui
      CONFIG_INSTANCE_LAPI_AUTH_PASSWORD_FILE: /run/secrets/crowdsec_password
      CONFIG_INSTANCE_LAPI_TLS_CA_FILE: /certs/root_ca.crt
    secrets:
      - crowdsec_password
    volumes:
      - ./data:/app/data
      - /path/on/host/root_ca.crt:/certs/root_ca.crt:ro
    restart: unless-stopped

secrets:
  crowdsec_password:
    file: ./secrets/crowdsec_password.txt
```

Keep the CA mount read-only. `CONFIG_INSTANCE_LAPI_TLS_CA_FILE` maps to `instances[0].lapi.tls.caFile`; no image rebuild is needed.

### HTTPS Reverse Proxy

CrowdSec Web UI listens for HTTP on port `3000` and does not obtain or terminate TLS certificates itself. Put a reverse proxy in front of it for HTTPS deployments and keep port `3000` private to the proxy.

HTTPS is required for passkeys because browsers expose WebAuthn only in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). `http://localhost` is suitable for local testing, but a remote deployment needs a stable hostname and a certificate trusted by the browser. Passkeys registered for one hostname cannot be used from a different hostname.

The proxy must preserve `Host` (or set `X-Forwarded-Host`) and set `X-Forwarded-Proto` to the original scheme. The application uses these headers for WebAuthn origins, secure session cookies, OIDC callback URLs, and mutation-origin checks.

#### Traefik example

This minimal example assumes Traefik already has a `websecure` entrypoint, a Let's Encrypt resolver named `letsencrypt`, and an external Docker network named `proxy`. Add the labels and proxy network to the existing Web UI service, replacing the hostname and CrowdSec settings.

```yaml
services:
  crowdsec-web-ui:
    image: ghcr.io/theduffman85/crowdsec-web-ui:latest
    expose:
      - "3000"
    environment:
      CONFIG_INSTANCE_LAPI_URL: http://crowdsec:8080
      CONFIG_INSTANCE_LAPI_AUTH_USERNAME: crowdsec-web-ui
      CONFIG_INSTANCE_LAPI_AUTH_PASSWORD: your-crowdsec-password
      # For https://crowdsec.example.com/crowdsec/:
      # CONFIG_SERVER_BASE_PATH: /crowdsec
    volumes:
      - ./data:/app/data
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      # For /crowdsec/, append: && PathPrefix(`/crowdsec`)
      - 'traefik.http.routers.crowdsec-web-ui.rule=Host(`crowdsec.example.com`)'
      - traefik.http.routers.crowdsec-web-ui.entrypoints=websecure
      - traefik.http.routers.crowdsec-web-ui.tls.certresolver=letsencrypt
      - traefik.http.services.crowdsec-web-ui.loadbalancer.server.port=3000
    networks:
      - proxy
      - crowdsec
    restart: unless-stopped

networks:
  proxy:
    external: true
  crowdsec:
    external: true
    name: your_crowdsec_network
```

Traefik supplies the forwarded headers and WebSocket upgrade handling automatically. See the [Traefik ACME documentation](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/) if the `letsencrypt` resolver is not configured yet.

#### Nginx example

This equivalent example assumes Nginx already terminates HTTPS and the Web UI port is published only on loopback, for example `127.0.0.1:3000:3000`.

```nginx
# For https://crowdsec.example.com/crowdsec/, set
# CONFIG_SERVER_BASE_PATH=/crowdsec and replace both `/` paths below
# with `/crowdsec/`.
location / {
    proxy_pass http://localhost:3000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

#### Proxy requirements

- The base path starts with `/` and has no trailing slash.
- `/` redirects to it; APIs, assets, and navigation follow it automatically.
- With Traefik on a shared hostname, add `CONFIG_SERVER_BASE_PATH: /crowdsec` and use a router rule such as ``Host(`example.com`) && PathPrefix(`/crowdsec`)``. Do not configure `StripPrefix`; the application expects to receive the base path.
- The backend checks browser mutation origins, applies a Content Security Policy, limits API bodies to 1 MiB, and marks API responses `private, no-store`.
- Command-line and service clients without browser `Origin` and `Sec-Fetch-Site` headers remain compatible.
- Configure HSTS at the TLS-terminating proxy; the application does not emit it.

### Health Check

The public endpoint is `GET /api/health`. Startup does not wait for LAPI: bootstrap retries in the background, so the container can become healthy before synchronization completes.

```bash
curl http://localhost:3000/api/health
# {"status":"ok"}
```

The built-in check runs every 30 seconds with a five-second timeout, a 10-second start period, and three retries.

```bash
docker inspect --format='{{.State.Health.Status}}' crowdsec_web_ui
```

`server.basePath` does not affect the internal check at `localhost:3000/api/health`. If `server.port` changes, update the health-check command and port mapping.

## Runtime Behavior

### Prometheus Metrics Page

- Reads a configured raw CrowdSec Prometheus endpoint. The Web UI does not configure one by default; CrowdSec normally exposes its local scrape at `http://127.0.0.1:6060/metrics`.
- Shows bouncer and machine LAPI activity, AppSec, parsers and datasources, LAPI latency, parsing time, and whitelist hits.
- Alert and decision analytics remain on the main dashboard.

Enable full metrics in CrowdSec's `/etc/crowdsec/config.yaml`.

```yaml
prometheus:
  enabled: true
  level: full
  listen_addr: 127.0.0.1
  listen_port: 6060
```

For separate containers, bind `listen_addr: 0.0.0.0` on a trusted network, then configure the matching Web UI instance.

```yaml
environment:
  CONFIG_INSTANCE_METRICS_URL: http://crowdsec:6060/metrics
```

| CrowdSec level | Result |
| --- | --- |
| `full` | All supported details, including per-machine, per-bouncer, and per-node metrics |
| `aggregated` | Less detail; omits those per-entity metrics |
| `none` | Disables metrics registration |

AppSec and latency sections appear only when CrowdSec emits those metrics. Time-window-only `rate()`/`increase()` metrics are intentionally omitted. See the [CrowdSec Prometheus documentation](https://docs.crowdsec.net/docs/next/observability/prometheus/).

### Display Preferences

- `crowdsec.simulationsEnabled: true` fetches non-remediating simulation alerts/decisions and shows badges, filters, and dashboard counts. Default: `false`.
- Alerts and Decisions column layouts persist per browser profile in local storage.
- `ID`, `Machine`, and `Origin` are hidden by default. `Machine` prefers `machine_alias`, then `machine_id`; multiple alert decision origins display as `Mixed`.
- Hidden columns remain searchable through fields such as `id:`, `machine:`, and `origin:`.

### Search Syntax

| Syntax | Example |
| --- | --- |
| Free text / quoted phrase | `ssh hetzner`, `"nginx bf"` |
| Field / exact value | `country:germany`, `country=DE` |
| Date comparison | `date>=2026-03-24`, `date<2026-03-25T12:00:00Z` |
| Negative / empty | `-sim:simulated`, `sim<>simulated`, `origin:""`, `origin<>""` |
| Boolean / grouping | `country:(germany OR france) AND -sim:simulated` |
| Decision filters | `status:active AND action:ban`, `alert:123 OR ip:"192.168.5.0/24"` |

Date fields support `<`, `>`, `<=`, `>=`, and `=>`. A bare field name is free text unless followed by `:`. Quote literal `AND`, `OR`, or `NOT`. The search `Info` button lists page-specific fields and examples.

#### Examples

| Page | Query |
| --- | --- |
| Alerts | `country:germany ssh` |
| Alerts | `date>=2026-03-24 AND date<2026-03-25` |
| Alerts | `country:(germany OR france) AND -sim:simulated` |
| Alerts | `origin:""` |
| Decisions | `status:active AND action:ban` |
| Decisions | `date>=2026-03-24 AND action:ban` |
| Decisions | `alert:123 OR ip:"192.168.5.0/24"` |

### Alert Source Filtering

Limit the local cache by origin when CrowdSec ingests automation, blocklists, or community feeds.

```yaml
crowdsec:
  alertFilters:
    includeOrigins: [crowdsec, cscli-import]
    excludeOrigins: [cscli]
    includeCapi: true
    includeOriginEmpty: true
    excludeOriginEmpty: false
```

| Origin | Source |
| --- | --- |
| `crowdsec` | Security-engine decisions |
| `cscli` | Manual `cscli decisions add` |
| `cscli-import` | `cscli decisions import` |
| `lists` | Imported list feeds |
| `CAPI` | Central API / community blocklist |

#### Behavior

- No explicit filters fetches the normal non-CAPI/non-lists feed.
- Includes are pushed upstream where possible. Generic excludes and empty-origin handling run locally because LAPI lacks those filters.
- `includeCapi: true` adds CAPI to the default feed; `includeOrigins: [CAPI]` selects only CAPI.
- If any origin is excluded, the whole alert is dropped.
- Origins prefer associated decisions, then blocklist/list source scopes for alerts without decisions.
- `includeOriginEmpty` retains origin-less alerts alongside includes; `excludeOriginEmpty` removes them.
- Because Decisions is built from synchronized alerts, filters also change which imported decisions appear.

#### Examples

| Setting | Result |
| --- | --- |
| `includeOrigins: [crowdsec]` | Keeps security-engine alerts only |
| `includeOrigins: [lists]` | Keeps list-based alerts only |
| `includeCapi: true` | Adds CAPI to the default feed |
| `includeOrigins: [CAPI]` | Keeps CAPI alerts only |
| `includeOriginEmpty: true` | Keeps origin-less alerts alongside explicit includes |
| `excludeOriginEmpty: true` | Removes origin-less alerts |
| `excludeOrigins: [cscli, lists]` | Removes manual and imported-list alerts |

## Notifications

Rules run against locally cached CrowdSec data, create in-app notifications, record delivery status, and optionally deliver outbound messages.

### Rules

Every rule has a name, severity (`info`, `warning`, `critical`), incident deduplication, and destination channels. Alert rules filter scenario, target, and simulation state; `IP Ban` and `New Alert/Decision` also accept exact IP/CIDR filters.

| Rule type | Behavior |
| --- | --- |
| `Alert Spike` | Compares the current window with the previous window and triggers when percentage increase and minimum alert count are exceeded. |
| `Alert Threshold` | Triggers when matching alerts in the configured time window reach the threshold. |
| `New Alert/Decision` | Creates one notification for every matching alert, decision, or both within the lookback window. Includes record ID, timestamps, scenario, target, source/value, and related alert/decision details. Stable per-record deduplication prevents repeats. |
| `IP Ban` | Triggers once for each active ban decision in the configured window, supports exact IP/CIDR filters, and deduplicates duplicate active decision rows for the same ban. |
| `Recent CVE` | Extracts CVE IDs from matching alerts and checks publication age before notifying. |
| `LAPI Availability` | Triggers when CrowdSec LAPI stays unavailable past the outage threshold, with optional recovery notifications. |
| `Application Update` | Uses the built-in update check and triggers when a newer CrowdSec Web UI version is available. |

#### Multi-instance behavior

| Scope | Rules |
| --- | --- |
| Aggregate matching alerts across instances | `Alert Spike`, `Alert Threshold`, `Recent CVE` |
| Evaluate each matching record | `New Alert/Decision`, `IP Ban` |
| Evaluate each instance | `LAPI Availability` |
| Application-wide | `Application Update` |

Instance-backed titles and metadata identify the contributing instance or instances.

> [!NOTE]
> The `Recent CVE` rule queries the NVD API to determine when a CVE was published. If outbound access to `services.nvd.nist.gov` is blocked, recent-CVE notifications may be skipped.

### Destinations

Destinations are independently enabled and reusable across rules. **Send Test** validates saved settings immediately; results are stored as `delivered` or `failed`.

| Destination | Settings |
| --- | --- |
| Email | SMTP host/port/security (`Plain SMTP`, `STARTTLS`, `SMTPS / Implicit TLS`), optional user/password, from address, comma-separated recipients, importance (`auto`, `normal`, `important`), and optional insecure TLS for trusted self-signed SMTP endpoints. Auto importance maps `info` to `normal` and `warning`/`critical` to `important`. |
| Gotify | Gotify URL, app token, and priority (`auto` or explicit integer). Auto priority maps `info` to `5`, `warning` to `7`, and `critical` to `10`. |
| ntfy | Server URL, topic, optional access token, and priority (`auto`, `min`, `low`, `default`, `high`, `urgent`). Auto priority maps `info` to `default`, `warning` to `high`, and `critical` to `urgent`. |
| MQTT | Generic publish-only output with broker URL, optional username/password/client ID, QoS `0` or `1`, keepalive, connect timeout, topic, and retain flag. It does not include Home Assistant discovery, entity sync, or command handling. |
| Webhook | Custom HTTP delivery with method (`POST`, `PUT`, `PATCH`), URL, optional query parameters/headers, auth (none, bearer token, or basic auth), body mode (`JSON`, `Text`, `Form`), timeout, retries, retry delay, and optional insecure TLS for trusted self-signed HTTPS endpoints. |

#### Payloads and security

- MQTT JSON contains `title`, `message`, `severity`, `metadata`, `sent_at`, `channel_id`, `channel_name`, `channel_type`, `rule_id`, `rule_name`, and `rule_type`. Tests use `rule_id=test`, `rule_name=Test notification`, and `rule_type=test`.
- Webhook templates expose dotted `event.*` fields for `title`, `message`, `severity`, `metadata`, `sent_at`, `channel_name`, `rule_id`, `rule_name`, and `rule_type`. Each has a `*Json` variant; nullable rule fields also have `OrUnknown` and `OrUnknownJson` aliases.
- Failed webhooks store HTTP status and a truncated response. `notifications.debugPayloads: true` also logs a truncated rendered body with sensitive form fields redacted; enable it only while troubleshooting.
- Destination secrets are masked and encrypted by `notifications.secretKey`, or an auto-generated key stored in application metadata.
- `notifications.allowPrivateAddresses: false` blocks private, loopback, and link-local destinations; default: `true`.
- Telegram, Home Assistant discovery/state, and inbound MQTT commands are not supported.

## Kubernetes

A [Helm chart for CrowdSec Web UI](https://github.com/zekker6/helm-charts/tree/main/charts/apps/crowdsec-web-ui) is maintained by zekker6.

## Persistence and Alert History

SQLite data lives under `/app/data`. Mount the directory—not only `crowdsec.db`—because WAL mode also uses `crowdsec.db-wal` and `crowdsec.db-shm`.

```yaml
volumes:
  - ./data:/app/data
```

- History survives restarts, merges with new LAPI data, and expires after `crowdsec.sync.lookback` (default: seven days).
- Initial imports and reconciliation retry in smaller windows after timeouts.
- During LAPI outages, the application serves its available cache and retries in the background; partial imports are marked.

Use `POST /api/cache/clear` for a full cache reset. Synchronization internals are documented in [DEVELOPMENT.md](DEVELOPMENT.md#cache-and-synchronization-internals).

## Documentation

| Guide | Contents |
| --- | --- |
| [Configuration example](config.example.yaml) | Complete commented YAML configuration |
| [API reference](API.md) | Authentication, routes, parameters, and request/response shapes |
| [Development guide](DEVELOPMENT.md) | Local setup, builds, tests, metadata, translations, and synchronization internals |
| [Load testing guide](LOAD_TESTING.md) | Synthetic profiles, overrides, benchmarks, and container workflow |
| [CrowdSec LAPI](https://docs.crowdsec.net/docs/local_api/intro/) | LAPI purpose, architecture, and authentication overview |
| [CrowdSec configuration](https://docs.crowdsec.net/docs/configuration/crowdsec_configuration/) | LAPI server settings and trusted IPs |
| [CrowdSec TLS authentication](https://docs.crowdsec.net/docs/local_api/tls_auth/) | Agent mTLS setup |
| [CrowdSec Prometheus](https://docs.crowdsec.net/docs/next/observability/prometheus/) | Runtime metrics configuration |

## Related Projects

<table>
  <tr>
    <td width="80" align="center" valign="middle">
      <a href="https://github.com/TheDuffman85/linux-update-dashboard">
        <img src="https://raw.githubusercontent.com/TheDuffman85/linux-update-dashboard/main/assets/logo.svg" alt="Linux Update Dashboard Logo" width="56" />
      </a>
    </td>
    <td valign="middle">
      <a href="https://github.com/TheDuffman85/linux-update-dashboard"><strong>Linux Update Dashboard</strong></a><br />
      A self-hosted dashboard for checking and applying Linux package updates across multiple servers.
    </td>
  </tr>
</table>

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=TheDuffman85/crowdsec-web-ui&type=date&legend=top-left&sealed_token=sIZgMEsvAELrAcobilkaKTbofrchv0xMb7iRiIfxjDZWY44Qt7QkWhQje7Y8KV0jT1Bta4U_DQIN9H000PGFXvPmmEPblq9_j3GwwGq4dzsvRyJfa-MHZEbBO0BIqwzEZn46x-LjQUdE6FCjgGqUJAkAPX4pfK0rsV0aysAc9-GAKcAdKSHCG_sGXD0s)](https://www.star-history.com/?type=date&repos=TheDuffman85%2Fcrowdsec-web-ui)
