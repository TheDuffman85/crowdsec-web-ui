# Development Guide

Contributor setup, build metadata, verification, and implementation notes for CrowdSec Web UI.

- Operator setup and configuration: [README.md](README.md)
- Synthetic performance testing: [LOAD_TESTING.md](LOAD_TESTING.md)
- Application API: [API.md](API.md)

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | `24.18.0` |
| pnpm | `11.9.0` |
| CrowdSec | A reachable LAPI for normal development |

### Install dependencies

Install the project dependencies and GeoNames snapshot.

```bash
pnpm install
pnpm run geocoder:data
```

### GeoNames data

- `geocoder:data` downloads the `cities5000` and admin-1 extracts used for location labels.
- Delete `geonames/` and rerun the command to refresh the local snapshot.
- Packaged images contain a build-time snapshot and never download it at runtime.
- GeoNames data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Local Configuration

1. Create the local data and secret directories:

   ```bash
   mkdir -p data secrets
   cp config.example.yaml data/config.yaml
   ```

2. In `data/config.yaml`:

   - Set `storage.dataDir` to `./data`.
   - Set the LAPI URL to `http://localhost:8080`.
   - Set `password.file` to `./secrets/crowdsec_password.txt`.

3. Put the registered CrowdSec watcher password in `secrets/crowdsec_password.txt`.

The default local path is `./data/config.yaml`; use `CONFIG_FILE` only to select another existing file. For mTLS, replace password authentication with `type: mtls`, `certFile`, and `keyFile`.

See the [configuration reference](README.md#configuration) for all fields, environment overrides, and secret formats.

## Run and Build

### Development server

Development mode starts the API on port `3000` and Vite on port `5173`.

```bash
pnpm run dev
# or
./run.sh dev
```

### Production build

Build and start a local production bundle.

```bash
pnpm run build
pnpm start
# or build and start through the helper
./run.sh
```

### Project layout

| Path | Purpose |
| --- | --- |
| `client/` | React, Vite, and Tailwind CSS frontend |
| `server/` | Hono API and background services |
| `scripts/` | Data, test, release, and load-test helpers |
| `dist/client/` | Built static assets |
| `dist/server/` | Compiled server output |

## Verification

### Complete verification

```bash
pnpm run verify
```

### Individual checks

```bash
pnpm run test
pnpm run coverage
pnpm run typecheck
pnpm run lint
pnpm run build
```

The synthetic large-dataset workflow is documented separately in [LOAD_TESTING.md](LOAD_TESTING.md).

## Build and Image Metadata

These values apply when building a local production bundle or container image.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCKER_IMAGE_REF` | `theduffman85/crowdsec-web-ui` | Image checked for updates; accepts `owner/repo` or a registry-prefixed reference such as `ghcr.io/owner/repo`. |
| `VITE_VERSION` | `0.0.0` | UI version and update-comparison value. |
| `VITE_BRANCH` | `main` | UI branch label; `dev` enables development-build update comparisons. |
| `VITE_COMMIT_HASH` | Empty | Commit shown in the sidebar and used by update logic. |
| `VITE_BUILD_DATE` | Generated at build time | Build timestamp shown in the UI. |
| `VITE_REPO_URL` | `https://github.com/TheDuffman85/crowdsec-web-ui` | Repository used for release and commit links. |

## Development and Test Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKEND_URL` | `http://localhost:3000` | Vite proxy target for `/api`. |
| `CROWDSEC_MTLS_IMAGE` | `crowdsecurity/crowdsec:latest` | Image used by the CrowdSec mTLS smoke test. |
| `CROWDSEC_MTLS_KEEP` | `0` | Set to `1` to retain the disposable test container. |
| `CROWDSEC_MTLS_CONTAINER` | Generated | Override the disposable container name. |

`scripts/ensure-native-deps.mjs` also honors standard Node/npm cache variables: `COREPACK_HOME`, `XDG_CACHE_HOME`, `PREBUILD_INSTALL_CACHE`, `npm_config_cache`, `npm_config_devdir`, and `npm_config_nodedir`.

## CrowdSec mTLS Smoke Test

The smoke test starts a disposable CrowdSec LAPI container, mounts an isolated temporary CrowdSec data directory, generates temporary server and client certificates, enables client-certificate verification, logs in through the Web UI LAPI client, and confirms that CrowdSec registered the TLS machine.

```bash
pnpm run test:mtls:crowdsec
```

### Overrides

```bash
CROWDSEC_MTLS_IMAGE=crowdsecurity/crowdsec:latest pnpm run test:mtls:crowdsec
CROWDSEC_MTLS_KEEP=1 pnpm run test:mtls:crowdsec
CROWDSEC_MTLS_CONTAINER=my-crowdsec-test pnpm run test:mtls:crowdsec
```

`CROWDSEC_MTLS_KEEP=1` keeps both the container and its temporary mounted files and prints their paths for inspection. Remove them manually when finished.

## Cache and Synchronization Internals

### Synchronization

CrowdSec Web UI keeps normalized alert and decision history in SQLite.

- Bootstrap imports the configured lookback period in chunks.
- Regular refreshes import the newest delta and reconcile a bounded number of historical windows.
- Recent windows are checked more often; windows with cached active decisions are prioritized.
- Reconciliation progress persists across restarts and fair scheduling prevents old windows from starving.
- The moving current window shares the normal delta request when due, avoiding a duplicate LAPI call.
- Normal and idle refresh intervals trigger each target cadence.
- Timed-out history requests retry with smaller windows down to `crowdsec.sync.alertSyncMinChunk`.
- Failed bootstrap work retries in the background using `crowdsec.sync.bootstrapRetryDelay`; partially imported caches remain available and are marked partial.

### Write and deletion safety

- Only changed alerts and added or deleted decisions are written.
- Unchanged alerts are compared without constructing decision mutations, keeping large blocklist checks inexpensive.
- Missing records are deleted only after every required LAPI query for the window succeeds.
- Relative LAPI ranges are padded and filtered back to exact local boundaries so transport delay, timestamp rounding, or partial scope responses cannot cause destructive reconciliation.
- `decisions.alert_id` is authoritative; alert rows do not duplicate embedded decision objects or ID arrays.
- Unknown CrowdSec extensions and open-ended event metadata remain compact JSON; legacy full-payload columns are cleared during migration.
- Active duplicate winners are refreshed in batches and stored as indexed flags.
- Alerts are indexed and ordered by CrowdSec `start_at` when present, otherwise `created_at`, so replayed alerts retain their original event time.
- Retention follows `crowdsec.sync.lookback` and cleanup is automatic.

To force a full cache reset, call `POST /api/cache/clear`. See [API.md](API.md) for authentication and request details.

## Translations

Translations live in `client/src/locales/`. Keep every locale aligned with `client/src/locales/en.json`. Server-side localization reuses these files, so update notification and synchronization keys together with related UI copy.
