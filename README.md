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

A self-hosted web dashboard for [CrowdSec](https://crowdsec.net/) to review alerts, manage decisions, configure notifications, and optionally view runtime metrics.

<div align="center">
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/react-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB" alt="React" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/vite-%23646CFF.svg?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/tailwindcss-%2338B2AC.svg?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node.js-%23339933.svg?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" /></a>
</div>

## Features

- **Dashboard**: total alerts, live active decisions, source-location attack markers with hover details, drilldowns, top lists, dynamic filtering, and simulation-mode counts when enabled.
- **Alerts and details**: searchable security-event history with simulation labels, attacker IP, AS, location map, and triggered-event breakdowns.
- **Decisions**: active/expired ban management, duplicate hiding, simulation filters, and the same unified search used on Alerts.
- **Manual actions**: add bans directly from the UI with custom duration and reason.
- **Runtime metrics**: optional Prometheus-backed views for bouncer and machine API activity, AppSec, parser flow, LAPI latency, parsing-time, and whitelist activity.
- **Multiple CrowdSec instances**: connect several CrowdSec LAPIs and switch between individual instances or a Combined scope.
- **Performance and scale**: backend caching and optimized sync reduce resource pressure and support larger deployments with multiple machines or high alert/decision volumes.
- **Notifications**: rules for alert spikes, thresholds, new alerts/decisions, IP bans, recent CVEs, LAPI availability, and application updates; delivery to Email, Gotify, MQTT, ntfy, and Webhooks.
- **Unified search**: free text plus quoted phrases, `field:value`, `AND`, `OR`, `NOT`, unary `-`, parentheses, and page-specific help from the `Info` button.
- **Modern UI**: dark/light themes, responsive layouts, and fast React interactions.
- **Settings**: language, refresh cadence, manual refresh availability, password login, passkeys, and OIDC SSO in one page.
- **Localization**: Arabic, English, German, French, Hindi, Japanese, Portuguese, Spanish, Russian, and Chinese. Browser-default language affects the UI; an explicitly saved language also localizes server-generated sync and notification text. Browser-default server messages stay English because background jobs do not have browser locale context.
- **Authentication**: password login, passkeys, and OIDC SSO can protect the browser UI and protected API routes. New installs start with authentication enabled and initial admin setup; older migrated installs retain their prior authentication state until they opt in.

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

> [!CAUTION]
> **Security Notice**: CrowdSec Web UI includes built-in authentication, but public deployments should still run behind HTTPS and a hardened reverse proxy. For centralized access control, configure OIDC SSO with an Identity Provider (IdP) such as [Authentik](https://goauthentik.io/), [Authelia](https://www.authelia.com/), or [Keycloak](https://www.keycloak.org/). Existing installs upgraded from versions without authentication remain unauthenticated until they explicitly enable it.
> Set `ui.readOnly: true` to run an instance that can view data but cannot perform CrowdSec write actions or management actions such as changing refresh settings, managing notification destinations/rules, sending notification tests, or deleting notifications. Language and marking notifications as read remain writable. This is an instance-wide safety mode, not user management or per-user RBAC.

## Architecture

- **Client**: React (Vite) + Tailwind CSS in `client/`; the build emits static assets to `dist/client`.
- **Server**: Node.js (Hono) in `server/`; the build emits compiled output to `dist/server`.
- **Cache/database**: SQLite (`better-sqlite3`) stores alerts, decisions, preferences, auth metadata, and notification state under `/app/data`.
- **CrowdSec integration**: the server authenticates to LAPI as a machine with watcher password auth or agent mTLS, then keeps a local cache updated with delta refreshes and chunked historical sync.
- **Container security**: the image runs as the non-root `node` user. Authentication can separately protect the browser UI and protected application API routes with password login, passkeys, and OIDC SSO.

See [API.md](API.md) for the application API reference, including auth behavior, route lists, query parameters, and request/response shapes.

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
      A self-hosted web app for checking and applying Linux package updates across multiple servers from one browser dashboard.
    </td>
  </tr>
</table>

## Prerequisites

You need a running CrowdSec instance and exactly one CrowdSec LAPI authentication mode:

1. **Watcher password auth**
   Generate a password and register the Web UI machine:
   ```bash
   openssl rand -hex 32
   docker exec crowdsec cscli machines add crowdsec-web-ui --password <generated_password> -f /dev/null
   ```

2. **Agent mTLS auth**
   Configure CrowdSec LAPI TLS auth and generate an agent client certificate/key pair for this Web UI as described in the [CrowdSec TLS authentication docs](https://docs.crowdsec.net/docs/local_api/tls_auth/).

> [!NOTE]
> The `-f /dev/null` flag is crucial. It tells `cscli` **not** to overwrite the existing credentials file of the CrowdSec container. We only want to register the machine in the database, not change the container's local config.

## Run with Docker (Recommended)

The examples below use `CONFIG_` environment overrides. On first startup, the application creates `/app/data/config.yaml`: explicitly supplied values are active, while application defaults are included as comments so future default changes can take effect. On later startups, it applies `CONFIG_` overrides without changing the existing file by default. The complete commented YAML reference is [`config.example.yaml`](config.example.yaml).

1. **Pull the prebuilt image**:

   ```bash
   docker pull ghcr.io/theduffman85/crowdsec-web-ui:latest
   ```

> [!NOTE]
> Current Docker images are based on Node.js rather than Bun, so the previous Bun/AVX-specific x64 runtime limitation no longer applies.

2. **Create the data directory and run the container**:

   ```bash
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

Ensure the container is on a Docker network that can reach the configured LAPI URL.

### Docker Compose Example

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

The repository ships the same layout in [`docker-compose.yml`](docker-compose.yml). Set the generated password and adjust the other `CONFIG_` values if necessary, then run `docker compose up -d`.

### Docker Compose Example (mTLS Authentication)

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

Adjust the LAPI URL and certificate paths for your deployment. Uncomment `CONFIG_INSTANCE_LAPI_TLS_CA_FILE` and its matching volume when the LAPI server uses a private CA.

## Configuration

The application loads `/app/data/config.yaml` in Docker and `./data/config.yaml` locally. Set `CONFIG_FILE` only to select another existing file. [`config.example.yaml`](config.example.yaml) is the complete commented example.

When the default file does not exist, it is created once with an explanatory header and a complete non-legacy field reference. Values supplied through setup environment variables are written as active YAML; application defaults and examples for optional fields are shown as comments, so omitted settings continue to follow the defaults of the installed version. Generated mappings use block-style rows and follow the configuration order documented below. Once created, the file is user-managed: the application does not refresh its explanatory text or commented defaults.

At startup, recognized `CONFIG_` variables are parsed as YAML values, merged over the file in memory, and validated. They are written to YAML only when the application creates the initial default configuration; by default, an existing file is never changed by overrides. Precedence is section variable, field variable, then indexed array variable. Removing an environment variable reveals the value from the file again. Restart after changing configuration or rotating a referenced secret.

Set `CONFIG_PERSIST_OVERRIDES: "true"` to write the validated merged values back to the selected YAML file on every startup that has `CONFIG_` overrides. This is disabled by default. Comments are preserved where possible, and direct secret overrides are stored as `env` references rather than plaintext. Once persisted, removing a non-secret environment variable leaves its last value active in YAML; persisted secret references still require the referenced environment variable to be present.

Startup logs list every applied `CONFIG_` variable, its configuration path, and the previous and replacement values. Credential values are redacted; for secret references, only the environment-variable name or file path is shown.

Array indexes are zero-based and contiguous: `CONFIG_AUTH_OIDC_ADMIN_GROUPS_0`, `CONFIG_INSTANCES_0_ID`, and `CONFIG_INSTANCES_0_METRICS_0_URL`. A whole section or array may instead be supplied as YAML through `CONFIG_SERVER`, `CONFIG_STORAGE`, `CONFIG_UI`, `CONFIG_AUTH`, `CONFIG_NOTIFICATIONS`, `CONFIG_UPDATES`, `CONFIG_CROWDSEC`, or `CONFIG_INSTANCES`.

Use singular `CONFIG_INSTANCE_*` for instance `0`; for example, `CONFIG_INSTANCE_NAME` is equivalent to `CONFIG_INSTANCES_0_NAME`. The metrics index `0` may also be omitted, so `CONFIG_INSTANCES_0_METRICS_URL` equals `CONFIG_INSTANCES_0_METRICS_0_URL`, while `CONFIG_INSTANCE_METRICS_URL` uses both shorthand forms. Do not set equivalent forms for the same field.

Secrets accept a direct string or exactly one `env: NAME` / `file: PATH` reference in YAML. Secret environment overrides also accept `_FILE`. When the initial YAML is created, direct secret overrides are written as environment references, never as plaintext.

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

### Authentication and notifications

| YAML field | Default | Purpose | Environment override |
| --- | --- | --- | --- |
| `auth.enabled` | `auto` | Enables authentication; `auto` enables new databases while preserving migrated database state. | `CONFIG_AUTH_ENABLED` |
| `auth.sessionSecret` | Generated and stored | Signs sessions and encrypts saved authentication settings. | `CONFIG_AUTH_SESSION_SECRET` or `CONFIG_AUTH_SESSION_SECRET_FILE` |
| `auth.totpSecret` | `sessionSecret` | Encrypts stored per-account TOTP seeds. | `CONFIG_AUTH_TOTP_SECRET` or `CONFIG_AUTH_TOTP_SECRET_FILE` |
| `auth.totpSeed` | Unset | Optional base32 fallback TOTP seed for the password user. | `CONFIG_AUTH_TOTP_SEED` or `CONFIG_AUTH_TOTP_SEED_FILE` |
| `auth.oidc.issuerUrl` | Unset | OIDC provider issuer URL. | `CONFIG_AUTH_OIDC_ISSUER_URL` |
| `auth.oidc.clientId` | Unset | OIDC client identifier. | `CONFIG_AUTH_OIDC_CLIENT_ID` |
| `auth.oidc.clientSecret` | Unset | OIDC client secret. | `CONFIG_AUTH_OIDC_CLIENT_SECRET` or `CONFIG_AUTH_OIDC_CLIENT_SECRET_FILE` |
| `auth.oidc.scope` | `openid profile email` | Requested OIDC scopes; must include `openid`. | `CONFIG_AUTH_OIDC_SCOPE` |
| `auth.oidc.groupsClaim` | `groups` | Claim containing role-mapping groups. | `CONFIG_AUTH_OIDC_GROUPS_CLAIM` |
| `auth.oidc.adminGroups` | `[]` | Groups granted administrator access. | `CONFIG_AUTH_OIDC_ADMIN_GROUPS` or `CONFIG_AUTH_OIDC_ADMIN_GROUPS_<INDEX>` |
| `auth.oidc.readOnlyGroups` | `[]` | Groups granted read-only access. | `CONFIG_AUTH_OIDC_READ_ONLY_GROUPS` or `CONFIG_AUTH_OIDC_READ_ONLY_GROUPS_<INDEX>` |
| `auth.oidc.unmatchedRole` | `deny` | Role for unmatched OIDC users: `deny`, `admin`, or `read-only`. | `CONFIG_AUTH_OIDC_UNMATCHED_ROLE` |
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

Durations accept `ms`, `s`, `m`, `h`, or `d`, for example `500ms`, `30s`, `5m`, or `7d`.

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

Use `<INDEX>` for the zero-based instance index. The ID defaults to the index, the name defaults to `Instance <INDEX>`, and the LAPI authentication type is inferred from its credentials. Inferred values are shown as comments when the initial YAML is created, unless a compatibility identity must remain explicit. Explicit IDs must match lowercase letters, digits, `_`, and `-`, and should remain stable after data is imported.

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
| `instances[].lapi.url` | Required (`http://crowdsec:8080` in starter config) | Absolute HTTP(S) LAPI base URL without credentials or a path. | `CONFIG_INSTANCES_<INDEX>_LAPI_URL` |
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

Use `<INDEX>` for the instance index and `<METRIC_INDEX>` for its zero-based metrics endpoint index. The endpoint ID defaults to `<METRIC_INDEX>` and its name defaults to `Metrics <METRIC_INDEX>`. These inferred values are shown as comments when the initial YAML is created.

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

Add entries to the top-level `instances` array in the application YAML. Each entry defines a stable instance ID, display name, one LAPI connection, and zero or more metrics endpoints. Mount referenced secret and certificate files read-only.

```yaml
instances:
  - id: eu-prod
    name: EU Production
    icon: 🇪🇺
    lapi:
      url: https://crowdsec-eu:8080
      auth:
        type: password
        username: crowdsec-web-ui
        password:
          file: /run/secrets/eu-lapi-password
      tls:
        caFile: /etc/crowdsec-web-ui/certs/eu-ca.pem

    metrics:
      - id: lapi
        name: EU LAPI
        url: https://crowdsec-eu:6060/metrics
        auth:
          type: bearer
          token:
            file: /run/secrets/eu-metrics-token
        tls:
          caFile: /etc/crowdsec-web-ui/certs/eu-ca.pem

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
      url: https://crowdsec-us:8080
      auth:
        type: mtls
        certFile: /run/secrets/us-client-cert
        keyFile: /run/secrets/us-client-key
      tls:
        caFile: /run/secrets/us-ca
```

Instance and endpoint IDs must be unique URL-safe identifiers and should be treated as immutable database identities. Display names are also unique, but may be changed. The optional `icon` is a short text or emoji glyph shown in the instance selector; instances without one receive a colored-square icon, while the all-instance scope uses a grid icon. Do not reuse an existing ID for an unrelated LAPI. Configuration and referenced secrets are loaded once; restart the process or container after changing or rotating them.

LAPI password authentication uses `password` as a direct string or an object containing exactly one of `env` or `file`. LAPI mTLS uses `certFile` and `keyFile`. The separate `tls.caFile` controls server trust for either authentication mode. Prometheus supports omitted/`none`, `basic`, and `bearer` authentication. Basic auth uses the same `password` shape; bearer auth uses the equivalent `token` shape. Prometheus `tls` accepts `caFile` and an optional complete `certFile`/`keyFile` client pair.

Credentials embedded in URLs, ambiguous secret sources, partial certificate pairs, unreadable files, and TLS verification bypasses are rejected at startup. Direct YAML secrets are accepted, although file references are recommended.

Dashboard, Alerts, and Decisions support a Combined scope. Metrics always uses one selected instance and one of that instance's endpoints because CrowdSec exposes process-local counters whose sums would be misleading. Adding a decision or cleaning up an IP in Combined scope runs independently against every configured LAPI and reports partial failures. Row deletion and bulk row deletion always use each row's owning instance; upstream numeric IDs are never broadcast.

## Authentication

Authentication covers the browser UI and protected application API routes. The health endpoint remains public for container and reverse-proxy health checks. New installs start with authentication enabled and show an initial setup page where you create the first local administrator account. `enabled: auto` preserves the database-aware migration behavior: new databases enable authentication, while databases migrated from releases without authentication stay disabled. To opt in explicitly, set:

```yaml
auth:
  enabled: true
```

Set `auth.enabled: false` to disable authentication. This deployment setting is not configurable from the UI.

Local password login is available after onboarding. Authenticated users can change their own password, add optional TOTP verification for password sign-in, and register or remove their own passkeys from Settings. TOTP setup shows a QR code, an authenticator-app setup link for mobile devices, and the manual setup key; once enabled, password login requires the current authenticator code after the password is accepted. Alternatively, `auth.totpSeed` can reference a fallback base32 seed. A seed enrolled through Settings takes precedence. Administrators can also disable password login and configure OIDC SSO from Settings. OIDC can also be preconfigured in YAML:

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

Register the following redirect (callback) URI for the CrowdSec Web UI client in your identity provider:

```text
https://<crowdsec-web-ui-host>/api/auth/oidc/callback
```

The URI must exactly match the public URL used to access the Web UI, including the scheme, host, and any non-default port. When `server.basePath` is configured, include it before `/api`; for example, `basePath: /crowdsec` uses `https://<crowdsec-web-ui-host>/crowdsec/api/auth/oidc/callback`. Behind a reverse proxy, forward the public host through `Host` or `X-Forwarded-Host` and set `X-Forwarded-Proto` so the application sends the same URI to the identity provider.

OIDC Settings accepts the issuer URL, client ID, client secret, authorization scopes, groups claim, admin groups, read-only groups, and the unmatched-user policy. Saved Settings values override YAML defaults. Authorization scopes must include `openid`; add provider-specific scopes such as `groups` only when your IdP requires them for the configured groups claim. By default, OIDC users who match no configured group are denied. Set the unmatched-user policy to `admin` or `read-only` only when every user who can complete OIDC sign-in should receive that fallback role.

OIDC group mapping is lightweight RBAC. `ui.readOnly: true` is still instance-wide and overrides user roles. For OIDC, admin group matches get full access, read-only group matches can view data and keep allowed preferences, and users with no matching group follow `auth.oidc.unmatchedRole`.

OIDC identities are bound to the provider's stable issuer and subject claims. Existing OIDC rows are migrated in place on their next successful SSO login; if an OIDC username conflicts with a local account, the accounts remain separate. OIDC sessions have a 24-hour absolute lifetime and are not silently extended from stale role claims. OIDC-only accounts cannot register or use local passkeys, so removing access at the IdP cannot be bypassed by creating a permanent local credential. Password-backed local accounts keep their existing passkey support.

## Build and Image Metadata

These values are mainly relevant when building your own image or local production bundle.

| Variable | Default | Description |
| --- | --- | --- |
| `DOCKER_IMAGE_REF` | `theduffman85/crowdsec-web-ui` | Image reference used by the built-in update checker. Accepts `owner/repo` or registry-prefixed forms such as `ghcr.io/owner/repo`. |
| `VITE_VERSION` | `0.0.0` | Version label shown in the UI and used for update-check comparisons. |
| `VITE_BRANCH` | `main` | Branch label shown in the UI. `dev` enables dev-build update comparisons. |
| `VITE_COMMIT_HASH` | empty | Commit hash displayed in the sidebar and used for build metadata/update logic. |
| `VITE_BUILD_DATE` | auto-generated at build time | Build timestamp shown in the UI. |
| `VITE_REPO_URL` | `https://github.com/TheDuffman85/crowdsec-web-ui` | Repository URL used for release and commit links in the UI. |

## Development and Test Environment

| Variable | Default | Description |
| --- | --- | --- |
| `BACKEND_URL` | `http://localhost:3000` | Vite dev-server proxy target for `/api` during local frontend development. |
| `CROWDSEC_MTLS_IMAGE` | `crowdsecurity/crowdsec:latest` | Override image used by `pnpm run test:mtls:crowdsec`. |
| `CROWDSEC_MTLS_KEEP` | `0` | Set to `1` to keep the disposable CrowdSec test container after the mTLS smoke test. |
| `CROWDSEC_MTLS_CONTAINER` | auto-generated | Override the disposable container name used by the mTLS smoke test. |

> [!NOTE]
> `scripts/ensure-native-deps.mjs` also honors standard Node/npm cache variables such as `COREPACK_HOME`, `XDG_CACHE_HOME`, `PREBUILD_INSTALL_CACHE`, `npm_config_cache`, `npm_config_devdir`, and `npm_config_nodedir`. Those are generic toolchain settings rather than project-specific configuration, so they are not required for normal setup.

## Deployment Notes

### Trusted IPs for Delete Operations (Optional)

By default, CrowdSec may restrict certain write operations such as deleting alerts to trusted IP addresses. If you encounter `403 Forbidden` errors when trying to delete alerts, add the Web UI network or IP range to CrowdSec's trusted IPs list.

**Docker Setup**: Add the Web UI container's network to the CrowdSec configuration in `/etc/crowdsec/config.yaml` or via environment variable:

```yaml
api:
  server:
    trusted_ips:
      - 127.0.0.1
      - ::1
      - 172.16.0.0/12  # Docker default bridge network
```

Or using `TRUSTED_IPS` environment variable on the CrowdSec container:

```bash
TRUSTED_IPS="127.0.0.1,::1,172.16.0.0/12"
```

See the [CrowdSec documentation](https://docs.crowdsec.net/docs/local_api/intro/) for more details on LAPI configuration.

### Using CrowdSec Web UI with a Local or Custom Certificate

If CrowdSec LAPI uses HTTPS with a self-signed certificate or internal CA, the Web UI may fail with:

```
Login failed: unable to get local issuer certificate
```

Mount the CA certificate and configure it for the LAPI instance:

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

Replace `/path/on/host/root_ca.crt` with your CA file path and keep the mount read-only. This avoids rebuilding the image and applies the path as `instances[0].lapi.tls.caFile`.

### Reverse Proxy with Base Path

Use `server.basePath` to serve the Web UI under a non-root path such as `https://example.com/crowdsec/`:

```yaml
services:
  crowdsec-web-ui:
    image: ghcr.io/theduffman85/crowdsec-web-ui:latest
    container_name: crowdsec_web_ui
    ports:
      - "3000:3000"
    environment:
      CONFIG_SERVER_BASE_PATH: /crowdsec
      CONFIG_INSTANCE_LAPI_URL: http://crowdsec:8080
      CONFIG_INSTANCE_LAPI_AUTH_USERNAME: crowdsec-web-ui
      CONFIG_INSTANCE_LAPI_AUTH_PASSWORD_FILE: /run/secrets/crowdsec_password
    secrets:
      - crowdsec_password
    volumes:
      - ./data:/app/data
    restart: unless-stopped

secrets:
  crowdsec_password:
    file: ./secrets/crowdsec_password.txt
```

Nginx example:

```nginx
location /crowdsec/ {
    proxy_pass http://localhost:3000/crowdsec/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`CONFIG_SERVER_BASE_PATH` must start with `/` and must not include a trailing slash. When set, `/` redirects to the base path and all API calls, assets, and navigation use it automatically.

The backend applies a Content Security Policy, rejects browser mutation requests whose `Origin` does not match the public request origin, limits API request bodies to 1 MiB, and marks API responses as `private, no-store`. Command-line and service clients that omit browser `Origin` and `Sec-Fetch-Site` headers remain compatible. Configure HSTS at the TLS-terminating reverse proxy if desired; the application does not emit HSTS itself.

### Health Check

The image includes a `HEALTHCHECK` for `GET /api/health`, which does not require authentication. Startup is non-blocking: if CrowdSec LAPI is temporarily unavailable, the Web UI stays up and retries bootstrap in the background, so the container can become healthy before the first sync completes.

**Endpoint:** `GET /api/health` (no authentication required)

```bash
curl http://localhost:3000/api/health
# {"status":"ok"}
```

The built-in check runs every 30 seconds with a 10-second start period. Check Docker health with:

```bash
docker inspect --format='{{.State.Health.Status}}' crowdsec_web_ui
```

If you use `server.basePath`, the health check still targets `localhost:3000/api/health` directly inside the container, so no additional configuration is needed. If you change `server.port`, update the health check command and port mapping in your deployment to match.

## Runtime Behavior

### Prometheus Metrics Page

The Metrics page shows setup guidance until an instance has a `metrics` endpoint. Once configured, it reads CrowdSec's Prometheus endpoint for runtime observability: bouncer and machine LAPI activity, AppSec requests/blocks, parser and datasource activity, LAPI request latency, parsing timing, and whitelist hits.

The page intentionally avoids duplicating alert and decision analytics that are already covered by the main app dashboard and tables. Values come from the current raw Prometheus scrape, so the UI avoids CrowdSec metrics that only become useful with Grafana-style time-window `rate()` or `increase()` queries.

CrowdSec documents the endpoint at `http://127.0.0.1:6060/metrics` by default. To expose the bouncer, machine, AppSec, whitelist, and per-node parser details used by this page, enable Prometheus metrics in CrowdSec with `level: full` in `/etc/crowdsec/config.yaml`:

```yaml
prometheus:
  enabled: true
  level: full
  listen_addr: 127.0.0.1
  listen_port: 6060
```

If CrowdSec and the Web UI run in different containers, bind the CrowdSec metrics listener to an address reachable from the Web UI container and keep it on a trusted network. For example, in a Compose network you might use:

```yaml
prometheus:
  enabled: true
  level: full
  listen_addr: 0.0.0.0
  listen_port: 6060
```

Then add the endpoint to the matching Web UI instance through the container environment:

```yaml
environment:
  CONFIG_INSTANCE_METRICS_URL: http://crowdsec:6060/metrics
```

`level: aggregated` works with less detail because it omits per-machine/per-bouncer LAPI metrics and per-node parser metrics. AppSec and LAPI latency sections also depend on whether the corresponding CrowdSec Prometheus metrics are emitted by your deployment. `level: none` disables metrics registration.

Reference: [CrowdSec Prometheus documentation](https://docs.crowdsec.net/docs/next/observability/prometheus/).

### Simulation Mode Visibility

CrowdSec simulation mode generates alerts and decisions without live remediation. `crowdsec.simulationsEnabled` is `false` by default. Set it to `true` to fetch simulated data and show simulation badges, filters, and dashboard counts.

### Table Column Visibility

The Alerts and Decisions tables include a Columns button. Column layouts are saved in the browser's local storage, so each browser profile can keep its own table layout. `ID`, `Machine`, and `Origin` are hidden by default; `Machine` prefers `machine_alias` and falls back to `machine_id`; alerts with multiple decision origins show `Mixed`. Hidden columns remain searchable with advanced fields such as `id:`, `machine:`, and `origin:`.

### Search Syntax

The Alerts and Decisions pages use a single search box that supports both normal free-text search and optional advanced syntax.

- Plain words: `ssh hetzner`
- Quoted phrases: `"nginx bf"`
- Fielded search: `country:germany`, `status:active`
- Date comparisons: `date>=2026-03-24`, `date<2026-03-25T12:00:00Z`
- Exact/negative checks: `country=DE`, `sim<>simulated`, `-sim:simulated`
- Empty/non-empty fields: `origin:""`, `origin<>""`
- Boolean logic and grouping: `AND`, `OR`, `NOT`, `country:(germany OR france)`

Examples:

- Alerts: `country:germany ssh`
- Alerts: `date>=2026-03-24 AND date<2026-03-25`
- Alerts: `country:(germany OR france) AND -sim:simulated`
- Alerts: `origin:""`
- Decisions: `status:active AND action:ban`
- Decisions: `date>=2026-03-24 AND action:ban`
- Decisions: `alert:123 OR ip:"192.168.5.0/24"`

A field name by itself, such as `country`, is free text unless followed by `:`. Ordered comparisons (`<`, `>`, `<=`, `>=`, `=>`) are supported for `date`. To search literal operator words like `AND`, `OR`, or `NOT`, wrap them in double quotes. Use the `Info` button beside the search field for page-specific fields and examples.

### Alert Source Filtering

Use alert source filters when CrowdSec ingests large volumes from automation, imported blocklists, or community feeds and you want the Web UI cache to focus on specific origins.

Configuration:

```yaml
crowdsec:
  alertFilters:
    includeOrigins: [crowdsec, cscli-import]
    excludeOrigins: [cscli]
    includeCapi: true
    includeOriginEmpty: true
    excludeOriginEmpty: false
```

Behavior: without explicit filters, the Web UI fetches the normal non-CAPI/non-lists alert feed. Include origins are pushed upstream where possible. `includeCapi: true` adds the dedicated CAPI/community-blocklist query unless explicit include filters are also set. Empty-origin handling and generic excludes are local because CrowdSec LAPI does not expose those filters. If an alert contains any excluded origin, the whole alert is dropped. Origin checks prefer associated decision origins and fall back to CrowdSec blocklist/list source scopes for alerts without decisions.

Common origins:

- `crowdsec` for alerts carrying decisions created by the security engine
- `cscli` for alerts created by manual `cscli decisions add`
- `cscli-import` for alerts created by `cscli decisions import`
- `lists` for imported list feeds
- `CAPI` for Central API / community blocklist alerts

Examples:

- `includeOrigins: [crowdsec]` keeps only security-engine alerts
- `includeOrigins: [lists]` fetches only list-based alerts
- `includeCapi: true` keeps the default non-CAPI feed and adds CAPI/community-blocklist alerts; `includeOrigins: [CAPI]` fetches only CAPI/community-blocklist alerts
- `includeOrigins: [crowdsec]` with `includeOriginEmpty: true` keeps `crowdsec` alerts and alerts without an origin
- `excludeOriginEmpty: true` removes alerts without an effective origin from the synced cache
- `excludeOrigins: [cscli, lists]` removes manual `cscli` alerts and imported list alerts from the local synced cache view

Because the local decisions view is built from synced alerts, these settings also affect which imported decisions appear in the UI.

## Notifications

The **Notifications** page defines rules over locally cached CrowdSec data. Matching rules create in-app notifications, record delivery status, and can send outbound messages to one or more destinations.

### Rules

Every rule has a name, severity (`info`, `warning`, `critical`), incident-based deduplication, and one or more destination channels. Alert-based rules can filter scenario text, target text, and simulated alerts. `IP Ban` and `New Alert/Decision` rules also support exact IP and CIDR filters.

In multi-instance mode, rules are evaluated against the shared cache for all configured instances. `Alert Spike`, `Alert Threshold`, and `Recent CVE` aggregate matching alerts across instances; `New Alert/Decision` and `IP Ban` evaluate each matching record; and `LAPI Availability` evaluates each instance separately. Instance-backed notification titles include the contributing instance name or names, and the same instance context is included in notification metadata. `Application Update` remains application-wide.

| Rule type | Behavior |
| --- | --- |
| `Alert Spike` | Compares the current window with the previous window and triggers when percentage increase and minimum alert count are exceeded. |
| `Alert Threshold` | Triggers when matching alerts in the configured time window reach the threshold. |
| `New Alert/Decision` | Creates one notification for every matching alert, decision, or both within the lookback window. Includes record ID, timestamps, scenario, target, source/value, and related alert/decision details. Stable per-record deduplication prevents repeats. |
| `IP Ban` | Triggers once for each active ban decision in the configured window, supports exact IP/CIDR filters, and deduplicates duplicate active decision rows for the same ban. |
| `Recent CVE` | Extracts CVE IDs from matching alerts and checks publication age before notifying. |
| `LAPI Availability` | Triggers when CrowdSec LAPI stays unavailable past the outage threshold, with optional recovery notifications. |
| `Application Update` | Uses the built-in update check and triggers when a newer CrowdSec Web UI version is available. |

> [!NOTE]
> The `Recent CVE` rule queries the NVD API to determine when a CVE was published. If outbound access to `services.nvd.nist.gov` is blocked, recent-CVE notifications may be skipped.

### Destinations

You can enable/disable destinations independently and attach the same rule to several destinations. Saved secrets are masked in the UI and encrypted at rest with `notifications.secretKey`, or with an auto-generated key persisted in app metadata. **Send Test** validates a saved destination immediately. Delivery results are stored as `delivered` or `failed`. Private, loopback, and link-local destinations are allowed by default and can be blocked with `notifications.allowPrivateAddresses: false`.

| Destination | Settings |
| --- | --- |
| Email | SMTP host/port/security (`Plain SMTP`, `STARTTLS`, `SMTPS / Implicit TLS`), optional user/password, from address, comma-separated recipients, importance (`auto`, `normal`, `important`), and optional insecure TLS for trusted self-signed SMTP endpoints. Auto importance maps `info` to `normal` and `warning`/`critical` to `important`. |
| Gotify | Gotify URL, app token, and priority (`auto` or explicit integer). Auto priority maps `info` to `5`, `warning` to `7`, and `critical` to `10`. |
| ntfy | Server URL, topic, optional access token, and priority (`auto`, `min`, `low`, `default`, `high`, `urgent`). Auto priority maps `info` to `default`, `warning` to `high`, and `critical` to `urgent`. |
| MQTT | Generic publish-only output with broker URL, optional username/password/client ID, QoS `0` or `1`, keepalive, connect timeout, topic, and retain flag. It does not include Home Assistant discovery, entity sync, or command handling. |
| Webhook | Custom HTTP delivery with method (`POST`, `PUT`, `PATCH`), URL, optional query parameters/headers, auth (none, bearer token, or basic auth), body mode (`JSON`, `Text`, `Form`), timeout, retries, retry delay, and optional insecure TLS for trusted self-signed HTTPS endpoints. |

MQTT publishes JSON with `title`, `message`, `severity`, `metadata`, `sent_at`, `channel_id`, `channel_name`, `channel_type`, `rule_id`, `rule_name`, and `rule_type`. Test sends use `rule_id=test`, `rule_name=Test notification`, and `rule_type=test`.

Webhook templates support dotted `event.*` variables in bodies and templated fields. Available fields include `title`, `message`, `severity`, `metadata`, `sent_at`, `channel_name`, `rule_id`, `rule_name`, and `rule_type`, each with a `*Json` variant for unquoted JSON insertion. Nullable rule fields also provide `OrUnknown` and `OrUnknownJson` aliases. Failed webhook deliveries record the HTTP status and a truncated response body; `notifications.debugPayloads: true` also logs a truncated rendered request body, with sensitive form fields redacted.

Notification titles and bodies are localized when the global language selector is set to a specific language. With **Browser default**, outbound notification content is generated in English because server jobs do not have access to the browser locale.

### Notification Security Controls

`notifications.secretKey` can reference an external destination-secret encryption key; otherwise the backend generates one on first start and persists it in app metadata. `allowPrivateAddresses` controls private, loopback, and link-local destinations. `debugPayloads` should only be enabled temporarily while troubleshooting failed deliveries.

### Current Scope

The notification system supports in-app notification history, rule-based outbound delivery, and Email, Gotify, MQTT, ntfy, and Webhook destinations. It does **not** currently include Telegram, Home Assistant MQTT discovery, MQTT entity state publishing, or inbound commands.

### Run with Helm

A Helm chart for deploying `crowdsec-web-ui` on Kubernetes is available (maintained by the zekker6):
[https://github.com/zekker6/helm-charts/tree/main/charts/apps/crowdsec-web-ui](https://github.com/zekker6/helm-charts/tree/main/charts/apps/crowdsec-web-ui)

## Persistence & Alert History

All data is stored in SQLite under `/app/data`. With the default `storage.walEnabled: true`, mount the directory, not only `crowdsec.db`, because SQLite also uses `crowdsec.db-wal` and `crowdsec.db-shm` sidecar files.

For Docker run, add `-v $(pwd)/data:/app/data`. For Compose:

```yaml
volumes:
  - ./data:/app/data
```

### How It Works

The Web UI maintains local alert and decision history. Data from CrowdSec LAPI is preserved across restarts and merged with new data on boot. After bootstrap, each regular refresh imports the newest delta and reconciles a bounded number of alert-history windows for both additions and deletions. Recent windows are checked more often than old windows; windows that contain locally cached active decisions are prioritized. Reconciliation progress is persisted, replacing periodic full-cache refreshes without repeatedly fetching the entire lookback period.

Only changed alerts and added or deleted decisions are written during reconciliation. Unchanged alerts are compared without constructing decision-row mutations, which keeps large blocklist alerts cheap to check. A missing cached alert or decision is deleted only after every required LAPI query for that window succeeds. Relative LAPI time ranges are padded and then filtered back to exact local boundaries, so transport delay, timestamp rounding, or a partial scope response cannot cause destructive reconciliation. The moving current window shares the normal delta request when it is due, avoiding duplicate LAPI calls. Target cadences are triggered by the normal or idle refresh interval, and fair budget allocation prevents old due windows from being starved by active-window backlog.

Alerts and decisions are stored as normalized SQLite columns. The `decisions.alert_id` relationship is authoritative, so alert rows do not duplicate embedded decision objects or ID arrays. Only unknown CrowdSec extension fields and open-ended event metadata remain as compact JSON; legacy full-payload columns are cleared during migration. Active duplicate winners are refreshed in batches after sync and stored as indexed flags, so decision paging does not recalculate duplicate groups for every row. Alerts are indexed by CrowdSec `start_at` when present, falling back to `created_at`, so replayed alerts are shown at the original alert/event time rather than the replay import time. Alerts are kept for `crowdsec.sync.lookback` (default: 7 days), then cleaned up automatically. Historical and reconciliation requests that time out are retried in smaller windows down to `crowdsec.sync.alertSyncMinChunk`. If LAPI is unavailable during startup, bootstrap retries continue in the background using `crowdsec.sync.bootstrapRetryDelay`; if only some bootstrap windows fail, the UI serves the imported cache and marks sync partial while retries continue. To force a full cache reset, use `POST /api/cache/clear`.

## Local Development

1. **Install dependencies**

   You need Node.js `24.18.0` and pnpm `11.9.0`.
   ```bash
   pnpm install
   pnpm run geocoder:data
   ```

   The second command downloads the GeoNames `cities5000` and admin-1 extracts used for local attack-marker and table location labels, then saves them as an immutable snapshot. Re-run it after deleting the `geonames` directory when you want to refresh local development data. Official Docker images contain a snapshot from image build time and never download GeoNames data at runtime. GeoNames data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

2. **Configure YAML and its secret file**

   Copy the example to the default local path, change `storage.dataDir` to `./data`, change the LAPI URL to `http://localhost:8080`, and adjust any other settings:

   ```bash
   mkdir -p data secrets
   cp config.example.yaml data/config.yaml
   ```

   Change `password.file` to `./secrets/crowdsec_password.txt` and create that file with the generated watcher password. No `CONFIG_FILE` setting is needed; use it only when you intentionally want a different YAML path.

   For mTLS, replace the instance's password auth in YAML with `type: mtls`, `certFile`, and `keyFile`; no LAPI password environment variable is then needed.

3. **Start or build**

   Development mode starts the server on port 3000 and Vite on port 5173:
   ```bash
   pnpm run dev
   # or
   ./run.sh dev
   ```

   Production build/start:
   ```bash
   pnpm run build
   pnpm start
   # or build and start with the helper
   ./run.sh
   ```

4. **Manual large-dataset UI load test**

   To test the UI against a repeatable synthetic cache without using a large production CrowdSec instance, start the explicit `default` profile. Omitting the profile is equivalent:
   ```bash
   ./run.sh loadtest default
   ./run.sh loadtest
   ```

   The available named profiles reproduce different workloads:
   ```bash
   ./run.sh loadtest default
   ./run.sh loadtest blocklist
   ./run.sh loadtest blocklists-mixed
   ./run.sh loadtest multi-instance
   ./run.sh loadtest multi-instance-medium
   ```

   The `default` profile is a broad baseline for bootstrap, dashboard, filtering, paging, and refresh testing. It creates 300,000 alerts and 300,000 decisions over a 30-day lookback. One recent LISTS blocklist owns 100,000 decisions, while the remaining decisions are distributed across regular alerts. Decisions include active, expired, simulated, and duplicate-value cases. Every minute the fake LAPI adds 100 alerts and 100 decisions with a deterministic mix of regular origins.

   The `blocklist` profile mirrors a large CAPI/LISTS workload: 7,582 alerts, 410,463 decisions, and refresh batches containing 53,500 decisions split across LISTS and CAPI alerts.

   The `blocklists-mixed` profile exercises a more varied newest-window workload: 10,000 alerts and 500,000 decisions, with three recent blocklists containing 125,000, 100,000, and 60,000 decisions. The remaining 215,000 decisions are spread evenly across regular alerts. It also includes 1,000 alerts without decisions, 500 alerts whose decisions are already expired, and 8,000 decisions that expire 5–15 minutes after seeding so startup and early refreshes cross expiration boundaries. Each synthetic delta adds three blocklist alerts with a deterministic 1,000–25,000 decisions per alert, alternating their decision origins between LISTS and CAPI.

   The `multi-instance` profile is intended for quick local testing. It seeds three independent LAPI sources whose alert and decision IDs all start at 1: Primary has 25,000 alerts and decisions, Secondary 15,000 of each, and Edge 10,000 of each. Their blocklists contain 5,000, 3,000, and 2,000 decisions respectively.

   Use `./run.sh loadtest multi-instance-medium` for three equally sized medium instances. Each has 100,000 alerts, 100,000 decisions, and a 25,000-decision blocklist. Both profiles expose two synthetic Prometheus endpoints on Primary, one on Secondary, and none on Edge. Set `LOADTEST_FAILING_LAPI=true` to make Edge fail for partial-availability and partial-write testing. Benchmark single-instance and Combined requests separately.

   After the multi-instance server finishes bootstrapping, run `pnpm run loadtest:benchmark:multi`. It warms Alerts, Decisions, search, and Dashboard, then reports primary-only and Combined p50/p95 latency separately over three runs. Set `LOADTEST_BASE_URL` when the backend is not on `http://127.0.0.1:3133` and `LOADTEST_BENCHMARK_SAMPLES` to change the samples per run. Compare primary-only results, bootstrap logs, and process RSS with the existing 300k baseline; this script deliberately does not combine those measurements into a misleading single score.

   Profile defaults live in `scripts/load-test-profiles/`, with one file per profile. Environment variables still take precedence over profile values.

   Load-test mode seeds a repeatable fake-LAPI source dataset in a separate SQLite database, builds the frontend, and starts a local backend. Authentication is enabled by default with the administrator login `load` / `test`; set `CONFIG_AUTH_ENABLED=false` to disable it. The load user also has a dummy passkey so the passkey button and authentication request can be exercised under load; the passkey authentication itself is expected to fail. On startup, the backend imports that source dataset through the normal bootstrap/full-sync path before serving it from the app cache. The UI opens on the default Dashboard at `http://localhost:3000/`. The default source dataset is `300000` alerts and `300000` embedded decisions under `/tmp/crowdsec-web-ui-load-test`. Load-test mode prints source seed timings, sync progress, `/api` requests, and event-loop stalls of at least 100ms to the console while it runs.

   Override the dataset with environment variables:
   ```bash
   LOADTEST_ALERTS=1000 LOADTEST_DECISIONS=1000 ./run.sh loadtest
   ```

   Supported load-test variables:
   ```bash
   LOADTEST_ALERTS=300000
   LOADTEST_DECISIONS=300000
   LOADTEST_SEED=1337
   LOADTEST_DB_DIR=/tmp/crowdsec-web-ui-load-test
   LOADTEST_BACKEND_PORT=3000
   LOADTEST_ACTIVE_DECISION_RATIO=0.7
   LOADTEST_SIMULATION_RATIO=0.1
   LOADTEST_DUPLICATE_VALUE_RATIO=0.15
   LOADTEST_BLOCKLIST_DECISIONS=100000
   LOADTEST_BLOCKLIST_SIZES=
   LOADTEST_EMPTY_ALERTS=0
   LOADTEST_EXPIRED_ALERTS=0
   LOADTEST_EXPIRING_SOON_DECISIONS=0
   LOADTEST_REFRESH_ALERTS=100
   LOADTEST_REFRESH_DECISIONS=100
   LOADTEST_REFRESH_DECISIONS_MIN_PER_ALERT=0
   LOADTEST_REFRESH_DECISIONS_MAX_PER_ALERT=0
   LOADTEST_REFRESH_DECISION_ORIGINS=
   LOADTEST_MULTI_INSTANCE=false
   LOADTEST_FAILING_LAPI=false
   LOADTEST_SECONDARY_ALERTS=100000
   LOADTEST_SECONDARY_DECISIONS=100000
   LOADTEST_SECONDARY_BLOCKLIST_DECISIONS=25000
   LOADTEST_EDGE_ALERTS=25000
   LOADTEST_EDGE_DECISIONS=50000
   LOADTEST_EDGE_BLOCKLIST_DECISIONS=10000
   ```

   Application behavior uses the same `CONFIG_` variables documented in the Configuration section. Load-test profiles set defaults such as `CONFIG_AUTH_ENABLED=true`, `CONFIG_CROWDSEC_SYNC_LOOKBACK=30d`, `CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL=1m`, and `CONFIG_CROWDSEC_SIMULATIONS_ENABLED=true`; any `CONFIG_` variable can override them. OIDC uses the regular `CONFIG_AUTH_OIDC_*` variables, including the indexed group arrays.

   Both the initial source dataset and later refresh batches are exposed through the fake LAPI. By default, one synthetic blocklist alert contains `100000` of the requested decisions so load testing covers a very large single-alert payload; `LOADTEST_BLOCKLIST_DECISIONS` changes that concentration without changing `LOADTEST_DECISIONS`. `LOADTEST_BLOCKLIST_SIZES` takes precedence when set and accepts comma-separated sizes such as `125000,100000,60000`; each size creates a separate blocklist alert in the newest sync window, and decisions after those fixed blocks are distributed evenly among the remaining decision-bearing alerts. `LOADTEST_EMPTY_ALERTS` reserves trailing alerts with no decisions, `LOADTEST_EXPIRED_ALERTS` makes the preceding decision-bearing alerts contain only expired decisions, and `LOADTEST_EXPIRING_SOON_DECISIONS` makes that many of the evenly distributed decisions expire 5–15 minutes after the seed timestamp. On each due head refresh batch the fake LAPI exposes `LOADTEST_REFRESH_ALERTS` new synthetic alerts and `LOADTEST_REFRESH_DECISIONS` new synthetic decisions, timestamped inside that refresh's authoritative delta window, then the regular sync code imports them into SQLite. Setting `LOADTEST_REFRESH_DECISIONS_MAX_PER_ALERT` above zero switches delta generation to per-alert blocklists; their sizes are selected deterministically between `LOADTEST_REFRESH_DECISIONS_MIN_PER_ALERT` and the maximum, inclusive, instead of using `LOADTEST_REFRESH_DECISIONS`. Historical reconciliation requests do not generate unrelated refresh batches.

   The dev-build workflow publishes a containerized variant as `ghcr.io/theduffman85/crowdsec-web-ui:loadtest`. It is a drop-in replacement for the regular image: keep the same ports, authentication environment, OIDC environment, and `/app/data` volume, and change only the image tag. CrowdSec connection settings are ignored by the load-test server.

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

   Set `LOADTEST_PROFILE` to `default`, `blocklist`, `blocklists-mixed`, `multi-instance`, or `multi-instance-medium`; it defaults to `default`. Individual `LOADTEST_*` and `CONFIG_` environment variables can override values from the selected profile. The load-test image ignores `CONFIG_STORAGE_DATA_DIR` and uses `LOADTEST_DB_DIR` for its synthetic database, defaulting to `/tmp/crowdsec-web-ui-load-test` inside the container. This prevents seeding from overwriting the database mounted at `/app/data`. The synthetic database is recreated whenever the container starts.

5. **CrowdSec mTLS smoke test**

   Starts a disposable CrowdSec LAPI container, generates temporary server/client certificates, enables LAPI client certificate verification, logs in through the Web UI LAPI client, and confirms CrowdSec registered the TLS machine.
   ```bash
   pnpm run test:mtls:crowdsec
   ```

   Optional overrides:
   ```bash
   CROWDSEC_MTLS_IMAGE=crowdsecurity/crowdsec:latest pnpm run test:mtls:crowdsec
   CROWDSEC_MTLS_KEEP=1 pnpm run test:mtls:crowdsec
   CROWDSEC_MTLS_CONTAINER=my-crowdsec-test pnpm run test:mtls:crowdsec
   ```

## Translations

CrowdSec Web UI translations live in `client/src/locales/`. Keep the same keys as `client/src/locales/en.json` when correcting wording or adding a new language. Server-side localization reuses these locale files, so notification and sync-message keys should be updated alongside UI text.

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=TheDuffman85/crowdsec-web-ui&type=date&legend=top-left&sealed_token=sIZgMEsvAELrAcobilkaKTbofrchv0xMb7iRiIfxjDZWY44Qt7QkWhQje7Y8KV0jT1Bta4U_DQIN9H000PGFXvPmmEPblq9_j3GwwGq4dzsvRyJfa-MHZEbBO0BIqwzEZn46x-LjQUdE6FCjgGqUJAkAPX4pfK0rsV0aysAc9-GAKcAdKSHCG_sGXD0s)](https://www.star-history.com/?type=date&repos=TheDuffman85%2Fcrowdsec-web-ui)
