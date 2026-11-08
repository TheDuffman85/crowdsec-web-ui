# Long-term statistics with recognizable attack patterns and 90 days of history.
: "${LOADTEST_PROFILE_DESCRIPTION:=Statistics page: 40,000 shaped alerts in the cache, 90 days of statistics history in total, archived at the same daily rate before the cache, and collection enabled.}"
: "${LOADTEST_ALERTS:=40000}"
: "${LOADTEST_DECISIONS:=40000}"
: "${LOADTEST_BLOCKLIST_DECISIONS:=10000}"
: "${LOADTEST_STATISTICS:=true}"
: "${LOADTEST_STATISTICS_HISTORY_DAYS:=90}"
: "${LOADTEST_STATISTICS_DAILY_ALERTS:=0}"
: "${LOADTEST_REFRESH_DECISION_ORIGINS:=crowdsec}"
# One alert per minute keeps live traffic at the seeded daily rate.
: "${LOADTEST_REFRESH_ALERTS:=1}"
: "${LOADTEST_REFRESH_DECISIONS:=1}"
