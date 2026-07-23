# CrowdSec Web UI API

All HTTP API routes return JSON unless a route explicitly redirects for OIDC login/callback. Routes are served below `/api`, or below the configured `server.basePath` when set. `GET /api/health` is always registered at the root path and below the configured base path.

API request bodies are limited to 1 MiB. Browser requests using state-changing methods must be same-origin; non-browser clients that do not send `Origin` or `Sec-Fetch-Site` remain supported. API responses are marked `private, no-store`.

The browser UI authenticates with the HTTP-only `crowdsec_web_ui_session` cookie. There is no bearer-token API in this codebase. Authentication is enabled for new installs by default; migrated databases from older unauthenticated versions retain their prior state until `auth.enabled` is explicitly configured. When auth is enabled, protected API routes return `401` without a valid session.

Protected application routes also ensure the backend can authenticate to CrowdSec LAPI. If LAPI login fails, they return `502`.

`ui.readOnly: true` or a read-only user role blocks enforcement and management writes. Blocked requests return:

```json
{ "error": "Read-only mode is enabled", "code": "READ_ONLY" }
```

Read-only mode still allows user preferences and notification read-state writes.

## Common Behavior

### Pagination

Alert and decision list pagination uses `page` and `page_size` and is enabled only when `page` is present. Notification lists are always paginated and default to the first page.

- `page` defaults to `1` and is clamped to at least `1`.
- `page_size` defaults to `50` and is clamped from `10` to `200`.
- For high-volume alert and decision lists, `selectable_ids` contains IDs for the returned page only. Use additional pages to expand the loaded selection set.
- With multiple instances, responses also include `selectable_refs` entries containing both `instance_id` and the upstream record `id`.
- Paginated responses use:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "page_size": 50,
    "total": 0,
    "total_pages": 0,
    "unfiltered_total": 0
  },
  "selectable_ids": [],
  "selectable_refs": []
}
```

`selectable_refs` is omitted for single-instance deployments.

### Search and Filters

`GET /api/alerts` and `GET /api/decisions` support a structured `q` search when paginated. Search supports free text, quoted phrases, `AND`, `OR`, `NOT`, `-`, grouping, field matching with `:`, exact matching with `=`, inequality with `<>`, and date comparisons with `<`, `<=`, `>`, `>=`.

Alert search fields: `id`, `scenario`, `message`, `ip`/`source`, `country`, `as`, `target`, `date`/`created`/`created_at`/`time`, `sim`/`simulation`, `machine`, `origin`.

Use a quoted empty value to match an empty field, such as `origin:""`. Use `origin<>""` or `-origin:""` to require a non-empty value.

Decision search fields: `id`, `alert`/`alert_id`, `scenario`/`reason`, `ip`/`value`, `country`, `as`, `target`, `date`/`created`/`created_at`/`time`, `action`, `type`, `status`, `duplicate`, `sim`/`simulation`, `machine`, `origin`.

Date range filters use `dateStart` and `dateEnd`. Use `YYYY-MM-DD` for day buckets or values containing `T` for hour-level comparisons. `tz_offset` is an offset in minutes; `browser_tz` accepts an IANA timezone. They control local bucket comparisons when the server has no fixed timezone configured.

### Multiple Instances

- `instance=<instance-id>` selects one instance for paginated Alerts, Decisions, and Dashboard requests. `instance=all`, the default, selects the Combined scope.
- Single-record routes without an instance are available only when one instance is configured. Multi-instance deployments use the instance-qualified routes below.
- Bulk deletion uses `refs: [{ "instance_id": "primary", "id": 42 }]`. Plain `ids` requests are rejected when multiple instances are configured.
- Decision creation and cleanup accept `scope: "all"` or `scope: "instance"`. The latter also requires `instance_id`; omitting `scope` targets the primary instance.
- Multi-instance writes return per-instance `results`, `succeeded`, and `failed`. Partial success returns HTTP `207`.

## Health

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/health` | Public health check returning `{ "status": "ok" }`. |

## Auth

These routes are mounted below `/api/auth`. Auth setup/login routes are available without a session so onboarding and login can work.

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/auth/status` | Auth state, setup status, current user/session state, OIDC availability, passkey availability, and password-login state. |
| POST | `/api/auth/setup` | Create the first admin user and start a session. Requires `username` and `password`; only works before any auth user exists. |
| POST | `/api/auth/login` | Password login with `username` and `password`. Accounts with TOTP enabled also require `totpCode`; missing or invalid codes return `requiresTotp: true`. |
| POST | `/api/auth/logout` | Clear the session cookie. |
| GET | `/api/auth/me` | Current authenticated session user. |
| GET | `/api/auth/settings` | Auth settings visible to the current user, including OIDC settings metadata and password/passkey state. |
| PUT | `/api/auth/settings` | Admin-only auth settings update. Can disable password login and configure OIDC issuer, client ID, client secret, scopes, groups claim, admin groups, read-only groups, and unmatched-user policy. |
| POST | `/api/auth/change-password` | Change the current user's password. The user must be logged in with password auth. |
| POST | `/api/auth/totp/setup` | Start TOTP enrollment for the current password-authenticated user. Returns a base32 secret and `otpauth://` URI for QR setup. |
| POST | `/api/auth/totp/enable` | Complete TOTP enrollment with `{ "code": "123456" }`. |
| DELETE | `/api/auth/totp` | Disable Settings-enrolled TOTP for the current password-authenticated user with `{ "currentPassword": "..." }`. TOTP supplied through `auth.totpSeed` remains deployment-managed and cannot be disabled through the API. |
| GET | `/api/auth/passkeys` | List passkeys for the current user. |
| PATCH | `/api/auth/passkeys/:id` | Rename a passkey with `{ "name": "..." }`. |
| DELETE | `/api/auth/passkeys/:id` | Delete one of the current user's passkeys. |
| POST | `/api/auth/webauthn/register/options` | Start passkey registration for the current password-backed user. OIDC-only accounts receive `403`. |
| POST | `/api/auth/webauthn/register/verify` | Complete passkey registration. Optional `name` is stored as the passkey label. OIDC-only accounts receive `403`. |
| POST | `/api/auth/webauthn/login/options` | Start passkey login. Optional `username` narrows allowed credentials. |
| POST | `/api/auth/webauthn/login/verify` | Complete passkey login and start a session. |
| GET | `/api/auth/oidc/login` | Redirect to the configured OIDC provider. |
| GET | `/api/auth/oidc/callback` | OIDC callback handler; creates or updates the OIDC user session and redirects to the UI. |

## Configuration

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/config` | Runtime UI config, LAPI status, sync status, simulation setting, time settings, manual refresh availability, metrics availability, metrics sidebar preference, and permissions. |
| GET | `/api/instances` | Configured instance identities, LAPI and synchronization status, metrics endpoint identities, per-instance overrides, and aggregate availability. |
| PUT | `/api/config/metrics-sidebar` | Save the metrics sidebar preference. Body: `{ "visible": true }`. |
| PUT | `/api/config/refresh-interval` | Update the refresh interval. Body: `{ "interval": "manual" \| "0" \| "5s" \| "30s" \| "1m" \| "5m" }`. Blocked in read-only mode. |
| PUT | `/api/config/manual-refresh` | Enable or disable manual cache refreshes. Body: `{ "enabled": true }`. Blocked in read-only mode. |
| PUT | `/api/config/language` | Save language preference. Body: `{ "language": "browser" }` or a supported locale code. |

## Alerts

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/alerts` | List synced alerts. Without `page`, returns an array. With `page`, returns a paginated response. |
| GET | `/api/alerts/facets` | Return one bounded quick-filter facet across the complete effective alert result set. |
| GET | `/api/alerts/:id` | Fetch alert details, including CrowdSec `meta` context entries, from CrowdSec LAPI; hydrate with decisions; and apply simulation visibility. `:id` must be numeric. |
| GET | `/api/instances/:instanceId/alerts/:id` | Fetch an alert from a specific instance. |
| POST | `/api/alerts/bulk-delete` | Immediately hide multiple alerts and durably queue deletion of them and their linked decisions. Body: `{ "ids": [1, "2"] }`. Blocked in read-only mode. |
| DELETE | `/api/alerts/:id` | Immediately hide one alert and durably queue deletion of it and its linked decisions. `:id` must be numeric. Blocked in read-only mode. |
| DELETE | `/api/instances/:instanceId/alerts/:id` | Delete one alert from a specific instance and its local cache. Blocked in read-only mode. |

Supported paginated alert parameters: `instance`, `q`, `ip`, `country`, `scenario`, `as`, `date`, `dateStart`, `dateEnd`, `target`, `simulation`, `include_decisions`, `tz_offset`, `browser_tz`.

Free-text `q` searches include CrowdSec alert context values from `meta` in addition to the standard alert and event metadata fields.

`simulation` accepts `all`, `live`, or `simulated`; unknown values behave like `all`.

Set `include_decisions=false` to omit decision hydration from paginated lists or single-instance alert details. Bulk deletion accepts `ids` in single-instance deployments or instance-qualified `refs` as described above.

Alert facets require `field=id|instance|scenario|country|region|city|as|ip|target|machine|origin|decision`. The `decision` facet returns `active`, `expired`, and an empty value for alerts without decisions. Facets accept the same filters as the paginated alert endpoint, plus optional case-insensitive `search`, `offset` (clamped to `0–500`), and `limit` (default `10`, maximum `50`). The requested field's own predicates are removed so counts remain disjunctive. Facet requests return `400` for unsupported fields and `504` when their isolated five-second query budget is exhausted.

## Decisions

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/decisions` | List decisions. Without `page`, returns an array. With `page`, returns a paginated response. Active decisions are returned by default. |
| GET | `/api/decisions/facets` | Return one bounded quick-filter facet across the complete effective decision result set. |
| POST | `/api/decisions` | Add a manual CrowdSec decision through LAPI. Body: `{ "ip": "1.2.3.4", "duration": "4h", "reason": "manual", "type": "ban" }`. `type` defaults to `ban` and accepts `ban` or `captcha`; optional `scope` and `instance_id` select targets. Blocked in read-only mode. |
| POST | `/api/decisions/bulk-delete` | Delete multiple decisions by numeric ID. Body: `{ "ids": [10, "11"] }`. Blocked in read-only mode. |
| DELETE | `/api/decisions/:id` | Delete one decision from CrowdSec LAPI and local cache. `:id` must be numeric. Blocked in read-only mode. |
| DELETE | `/api/instances/:instanceId/decisions/:id` | Delete one decision from a specific instance and its local cache. Blocked in read-only mode. |

Supported decision query parameters: `instance`, `include_expired`, `page`, `page_size`, `q`, `alert_id`, `country`, `scenario`, `as`, `ip`, `target`, `dateStart`, `dateEnd`, `simulation`, `hide_duplicates`, `tz_offset`, `browser_tz`.

- `include_expired=true` includes expired decisions within the configured lookback window.
- Duplicate decisions are hidden by default in paginated results. Set `hide_duplicates=false` or filter by `alert_id` to show them.
- `simulation` accepts `all`, `live`, or `simulated`; unknown values behave like `all`.
- Bulk deletion accepts `ids` in single-instance deployments or instance-qualified `refs` as described above.

Decision facets require `field=id|instance|alert|scenario|country|region|city|as|ip|target|action|status|machine|origin` and support the same facet pagination and search parameters as alert facets. Status faceting considers both active and expired values within the configured lookback window even when the list is currently active-only.

Both facet endpoints return at most the requested limit and use an empty string for missing raw values:

```json
{
  "field": "country",
  "values": [
    { "value": "DE", "count": 1234 },
    { "value": "", "count": 17 }
  ],
  "offset": 0,
  "has_more": true
}
```

## Cleanup and Cache

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/api/cleanup/by-ip` | Delete cached/LAPI alerts and decisions for one IP address or range. Body: `{ "ip": "1.2.3.4" }`; optional `scope` and `instance_id` select targets. Blocked in read-only mode. |
| POST | `/api/cache/refresh` | Run a manual refresh with `{ "mode": "delta" \| "latest" \| "full" }`. Requires manual refresh to be enabled; returns `409` when another refresh is running. |
| POST | `/api/cache/clear` | Clear synced alert/decision data and run a bootstrap sync. Blocked in read-only mode. |

Alert deletion, bulk deletion, and cleanup responses use:

```json
{
  "requested_alerts": 0,
  "requested_decisions": 0,
  "deleted_alerts": 0,
  "deleted_decisions": 0,
  "failed": [],
  "ip": "1.2.3.4"
}
```

Alert deletion requests return after a durable deletion tombstone is stored and the alert is removed from the visible cache. A backend worker expires linked decisions, waits for the configured bouncer propagation delay, and then deletes the owning alert. Pending work survives restarts, is processed before historical sync, and prevents sync from restoring the hidden alert. `ip` is only included for cleanup-by-IP responses.

## Stats and Dashboard

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/stats/alerts` | Alert records shaped for chart/stat consumers within the configured lookback window. |
| GET | `/api/stats/decisions` | Decision records shaped for chart/stat consumers within the configured lookback window. |
| GET | `/api/dashboard/stats` | Aggregated dashboard totals, filtered totals, top targets/countries/scenarios/AS, world-map country data, bounded source-location clusters, and history series. |

Supported dashboard filters: `instance`, `country`, `scenario`, `as`, `ip`, `target`, `dateStart`, `dateEnd`, `simulation`, `granularity`, `tz_offset`, `browser_tz`.

- `simulation` accepts `all`, `live`, or `simulated`.
- `granularity=hour` returns hourly buckets; any other value uses daily buckets.

## CrowdSec Metrics

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/metrics/crowdsec` | Fetch and normalize the primary instance's first metrics endpoint. Returns `404` when it is not configured and `502` when the metrics fetch fails. |
| GET | `/api/instances/:instanceId/metrics/:endpointId` | Fetch and normalize a specific instance metrics endpoint. Returns `404` for an unknown instance or endpoint and `502` when the fetch fails. |

The response includes `fetched_at`, `totals`, `bouncers`, `machines`, `parserSources`, `parserNodes`, `whitelists`, and `parserTimings`. It can also include runtime-only observability sections: `lapiRoutes` and `appsecEngines`.

Parser node entries include `isChild`, which is `true` for CrowdSec child parser nodes emitted with the `child-` prefix.

Parser, LAPI latency, AppSec, bouncer, and machine values are derived from the current CrowdSec Prometheus scrape. The endpoint does not query Prometheus history or calculate Grafana-style `rate()`/`increase()` windows, so metrics that require time-window tracking are intentionally omitted.

## Cache Update WebSocket

Connect to `/api/cache-updates`, below `server.basePath` when configured, using `ws://` or `wss://`. The upgrade uses the normal session cookie, enforces same-origin browser requests, and returns `401` when authentication fails.

Server messages are JSON:

| Type | Fields | Purpose |
| --- | --- | --- |
| `ready` | `updated_at` | Initial cache timestamp after connection. |
| `cache-updated` | `updated_at`, `instance_ids` | Signals that one or more instance caches changed. |
| `heartbeat` | `sent_at` | Sent every 30 seconds alongside the WebSocket ping. |

## Notifications

Notification inbox routes operate on generated notification items.

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/notifications` | List notification items. Supports `page` and `page_size`; defaults to page `1`, size `50` when omitted. |
| POST | `/api/notifications/:id/read` | Mark one notification as read. Allowed in read-only mode. |
| POST | `/api/notifications/bulk-read` | Mark multiple notifications as read. Body: `{ "ids": ["id-1", "id-2"] }`. Allowed in read-only mode. |
| POST | `/api/notifications/bulk-delete` | Delete multiple notifications. Body: `{ "ids": ["id-1", "id-2"] }`. Blocked in read-only mode. |
| POST | `/api/notifications/delete-read` | Delete all read notifications. Blocked in read-only mode. |
| DELETE | `/api/notifications/:id` | Delete one notification. Blocked in read-only mode. |
| GET | `/api/notifications/settings` | List notification channels and rules. |

Notification configuration routes manage destinations and rule definitions.

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/api/notification-channels` | Create a notification channel. Blocked in read-only mode. |
| PUT | `/api/notification-channels/:id` | Update a notification channel. Blocked in read-only mode. |
| DELETE | `/api/notification-channels/:id` | Delete a notification channel. Blocked in read-only mode. |
| POST | `/api/notification-channels/:id/test` | Send a test notification through a saved channel. Blocked in read-only mode. |
| POST | `/api/notification-rules` | Create a notification rule. Blocked in read-only mode. |
| PUT | `/api/notification-rules/:id` | Update a notification rule. Blocked in read-only mode. |
| DELETE | `/api/notification-rules/:id` | Delete a notification rule. Blocked in read-only mode. |

Channel create/update body:

```json
{
  "name": "Security alerts",
  "type": "ntfy",
  "enabled": true,
  "config": {}
}
```

Supported channel types: `ntfy`, `gotify`, `email`, `mqtt`, `webhook`.

Rule create/update body:

```json
{
  "name": "IP bans",
  "type": "ip-ban",
  "enabled": true,
  "severity": "warning",
  "channel_ids": ["channel-id"],
  "config": {}
}
```

Supported rule types: `alert-spike`, `alert-threshold`, `new-alert-decision`, `new-cve`, `ip-ban`, `application-update`, `lapi-availability`.

Supported severities: `info`, `warning`, `critical`.

## Update Check

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/update-check` | Check whether a newer application release is available. Response is not cached. |

Optional query parameters override the runtime version metadata used for the check: `version`, `branch`, `commit_hash`.

## Example Requests

List the first page of active decisions:

```bash
curl -b cookie.txt 'http://localhost:3000/api/decisions?page=1&page_size=50'
```

Search alerts with structured syntax:

```bash
curl -b cookie.txt 'http://localhost:3000/api/alerts?page=1&page_size=50&q=origin:(manual%20OR%20CAPI)%20AND%20-country:us'
```

Add a manual ban:

```bash
curl -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"ip":"1.2.3.4","duration":"4h","type":"ban","reason":"manual"}' \
  http://localhost:3000/api/decisions
```
