# Central LAPI with a large fleet of remote log processors and bouncers (issue #561).
: "${LOADTEST_PROFILE_DESCRIPTION:=Metrics fleet workload: one central LAPI with 40 remediation components, 45 log processors, and per-agent parser, AppSec, whitelist, and scenario metrics, plus 10k/10k alerts/decisions.}"
: "${LOADTEST_METRICS_BOUNCERS:=40}"
: "${LOADTEST_METRICS_MACHINES:=45}"
: "${LOADTEST_ALERTS:=10000}"
: "${LOADTEST_DECISIONS:=10000}"
: "${LOADTEST_BLOCKLIST_DECISIONS:=2000}"
: "${CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL:=1m}"
