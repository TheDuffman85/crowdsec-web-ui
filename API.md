# CrowdSec Web UI API

All API routes return JSON unless a route explicitly redirects for OIDC login/callback. Routes are served below `/api`, or below `${BASE_PATH}/api` when `BASE_PATH` is configured. `GET /api/health` is always registered at the root path; when `BASE_PATH` is set, `${BASE_PATH}/api/health` is registered too.

The browser UI authenticates with the HTTP-only `crowdsec_web_ui_session` cookie. There is no bearer-token API in this codebase. Authentication is enabled for new installs by default; migrated databases from older unauthenticated versions stay disabled until `AUTH_ENABLED=true` is set. When auth is enabled, protected API routes return `401` without a valid session.

Protected application routes also ensure the backend can authenticate to CrowdSec LAPI. If LAPI login fails, they return `502`.

`PERMISSION_READ_ONLY=true` or a read-only user role blocks enforcement and management writes. Blocked requests return:

```json
{ "error": "Read-only mode is enabled", "code": "READ_ONLY" }
```

Read-only mode still allows user preferences and notification read-state writes.

## Common Behavior

### Pagination

List endpoints that support pagination use `page` and `page_size`. Pagination is enabled only when the `page` query parameter is present.

- `page` defaults to `1` and is clamped to at least `1`.
- `page_size` defaults to `50` and is clamped from `10` to `200`.
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
  "selectable_ids": []
}
```

### Search and Filters

`GET /api/alerts` and `GET /api/decisions` support a structured `q` search when paginated. Search supports free text, quoted phrases, `AND`, `OR`, `NOT`, `-`, grouping, field matching with `:`, exact matching with `=`, inequality with `<>`, and date comparisons with `<`, `<=`, `>`, `>=`.

Alert search fields: `id`, `scenario`, `message`, `ip`/`source`, `country`, `as`, `target`, `date`/`created`/`created_at`/`time`, `sim`/`simulation`, `machine`, `origin`.

Decision search fields: `id`, `alert`/`alert_id`, `scenario`/`reason`, `ip`/`value`, `country`, `as`, `target`, `date`/`created`/`created_at`/`time`, `action`, `type`, `status`, `duplicate`, `sim`/`simulation`, `machine`, `origin`.

Date range filters use `dateStart` and `dateEnd`. Use `YYYY-MM-DD` for day buckets or values containing `T` for hour-level comparisons. `tz_offset` is an offset in minutes used for local bucket comparisons when the server has no fixed `TZ` configured.

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
| POST | `/api/auth/login` | Password login with `username` and `password`. |
| POST | `/api/auth/logout` | Clear the session cookie. |
| GET | `/api/auth/me` | Current authenticated session user. |
| GET | `/api/auth/settings` | Auth settings visible to the current user, including OIDC settings metadata and password/passkey state. |
| PUT | `/api/auth/settings` | Admin-only auth settings update. Can disable password login and configure OIDC issuer, client ID, client secret, scopes, groups claim, admin groups, read-only groups, and unmatched-user policy. |
| POST | `/api/auth/change-password` | Change the current user's password. The user must be logged in with password auth. |
| GET | `/api/auth/passkeys` | List passkeys for the current user. |
| PATCH | `/api/auth/passkeys/:id` | Rename a passkey with `{ "name": "..." }`. |
| DELETE | `/api/auth/passkeys/:id` | Delete one of the current user's passkeys. |
| POST | `/api/auth/webauthn/register/options` | Start passkey registration for the current user. |
| POST | `/api/auth/webauthn/register/verify` | Complete passkey registration. Optional `name` is stored as the passkey label. |
| POST | `/api/auth/webauthn/login/options` | Start passkey login. Optional `username` narrows allowed credentials. |
| POST | `/api/auth/webauthn/login/verify` | Complete passkey login and start a session. |
| GET | `/api/auth/oidc/login` | Redirect to the configured OIDC provider. |
| GET | `/api/auth/oidc/callback` | OIDC callback handler; creates or updates the OIDC user session and redirects to the UI. |

## Configuration

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/config` | Runtime UI config, LAPI status, sync status, simulation setting, table column preferences, time settings, metrics availability, metrics sidebar preference, and permissions. |
| PUT | `/api/config/metrics-sidebar` | Save the metrics sidebar preference. Body: `{ "visible": true }`. |
| PUT | `/api/config/table-columns` | Save visible columns for one table and viewport. Body: `{ "table": "alerts" \| "decisions", "viewport": "desktop" \| "mobile", "visible_columns": [...] }`. |
| PUT | `/api/config/refresh-interval` | Update the refresh interval. Body: `{ "interval": "manual" \| "0" \| "5s" \| "30s" \| "1m" \| "5m" }`. Blocked in read-only mode. |
| PUT | `/api/config/language` | Save language preference. Body: `{ "language": "browser" }` or a supported locale code. |

Alert columns: `id`, `time`, `scenario`, `country`, `as`, `source`, `machine`, `origin`, `decisions`.

Decision columns: `id`, `time`, `scenario`, `country`, `as`, `source`, `action`, `expiration`, `machine`, `origin`, `alert`.

## Alerts

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/alerts` | List synced alerts. Without `page`, returns an array. With `page`, returns a paginated response. |
| GET | `/api/alerts/:id` | Fetch alert details from CrowdSec LAPI, hydrate with decisions, and apply simulation visibility. `:id` must be numeric. |
| POST | `/api/alerts/bulk-delete` | Delete multiple alerts by numeric ID. Body: `{ "ids": [1, "2"] }`. Also deletes cached linked decisions. Blocked in read-only mode. |
| DELETE | `/api/alerts/:id` | Delete one alert from CrowdSec LAPI and local cache. `:id` must be numeric. Blocked in read-only mode. |

Supported paginated alert filters: `q`, `ip`, `country`, `scenario`, `as`, `date`, `dateStart`, `dateEnd`, `target`, `simulation`, `tz_offset`.

`simulation` accepts `all`, `live`, or `simulated`; unknown values behave like `all`.

## Decisions

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/decisions` | List decisions. Without `page`, returns an array. With `page`, returns a paginated response. Active decisions are returned by default. |
| POST | `/api/decisions` | Add a manual CrowdSec decision through LAPI. Body: `{ "ip": "1.2.3.4", "duration": "4h", "reason": "manual", "type": "ban" }`. `type` defaults to `ban` and accepts `ban` or `captcha`. Blocked in read-only mode. |
| POST | `/api/decisions/bulk-delete` | Delete multiple decisions by numeric ID. Body: `{ "ids": [10, "11"] }`. Blocked in read-only mode. |
| DELETE | `/api/decisions/:id` | Delete one decision from CrowdSec LAPI and local cache. `:id` must be numeric. Blocked in read-only mode. |

Supported decision query parameters: `include_expired`, `page`, `page_size`, `q`, `alert_id`, `country`, `scenario`, `as`, `ip`, `target`, `dateStart`, `dateEnd`, `simulation`, `hide_duplicates`, `tz_offset`.

- `include_expired=true` includes expired decisions within the configured lookback window.
- Duplicate decisions are hidden by default in paginated results. Set `hide_duplicates=false` or filter by `alert_id` to show them.
- `simulation` accepts `all`, `live`, or `simulated`; unknown values behave like `all`.

## Cleanup and Cache

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/api/cleanup/by-ip` | Delete cached/LAPI alerts and decisions for one IP address or range. Body: `{ "ip": "1.2.3.4" }`. Blocked in read-only mode. |
| POST | `/api/cache/clear` | Clear synced alert/decision data and run a bootstrap sync. Blocked in read-only mode. |

Bulk delete and cleanup responses use:

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

`ip` is only included for cleanup-by-IP responses.

## Stats and Dashboard

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/stats/alerts` | Alert records shaped for chart/stat consumers within the configured lookback window. |
| GET | `/api/stats/decisions` | Decision records shaped for chart/stat consumers within the configured lookback window. |
| GET | `/api/dashboard/stats` | Aggregated dashboard totals, filtered totals, top targets/countries/scenarios/AS, world-map country data, and history series. |

Supported dashboard filters: `country`, `scenario`, `as`, `ip`, `target`, `dateStart`, `dateEnd`, `simulation`, `granularity`, `tz_offset`.

- `simulation` accepts `all`, `live`, or `simulated`.
- `granularity=hour` returns hourly buckets; any other value uses daily buckets.

## CrowdSec Metrics

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/metrics/crowdsec` | Fetch and normalize CrowdSec Prometheus metrics. Returns `404` when `CROWDSEC_PROMETHEUS_URL` is not configured and `502` when the metrics fetch fails. |

The response includes `fetched_at`, `totals`, `bouncers`, `machines`, `parserSources`, `parserNodes`, `whitelists`, and `parserTimings`. It can also include runtime-only observability sections: `lapiRoutes` and `appsecEngines`.

Parser node entries include `isChild`, which is `true` for CrowdSec child parser nodes emitted with the `child-` prefix.

Parser, LAPI latency, AppSec, bouncer, and machine values are derived from the current CrowdSec Prometheus scrape. The endpoint does not query Prometheus history or calculate Grafana-style `rate()`/`increase()` windows, so metrics that require time-window tracking are intentionally omitted.

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
