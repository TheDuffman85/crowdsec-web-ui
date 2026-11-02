# Repeat attackers and one large recent burst for the grouped Alerts view.
: "${LOADTEST_PROFILE_DESCRIPTION:=Repeat attackers with 20-alert bursts from 5,000 IPs, plus a 60,000-alert burst from one IP in the newest 20 minutes.}"
: "${LOADTEST_ALERTS:=300000}"
: "${LOADTEST_DECISIONS:=300000}"
: "${LOADTEST_BLOCKLIST_DECISIONS:=0}"
: "${LOADTEST_ALERT_SESSION_SIZE:=20}"
: "${LOADTEST_ALERT_SOURCE_IPS:=5000}"
: "${LOADTEST_ALERT_BURST_SIZE:=60000}"
