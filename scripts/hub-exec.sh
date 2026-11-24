#!/usr/bin/env bash
# Locked-down executor for the Web UI "Scenarios / Hub" page.
#
# It runs on the machine that hosts a CrowdSec log processor and accepts exactly
# one request, a "verb line", from either:
#   - the SSH_ORIGINAL_COMMAND variable, when installed as an SSH forced command, or
#   - its own arguments, when HUB_EXECUTOR=command is used.
# Nothing is passed to a shell: the request is checked against the list below and
# turned into a fixed cscli call.
#
#   hub-list                          cscli hub list -a -o json
#   hub-update                        cscli hub update
#   upgrade-all                       cscli hub upgrade
#   install|remove|upgrade TYPE NAME  cscli TYPE install|remove|upgrade NAME
#   reload                            make CrowdSec re-read its configuration
#
# TYPE is scenarios, collections, parsers or postoverflows.
#
# Where CrowdSec runs is read from /etc/crowdsec-hub/hub-exec.conf (written by the
# installer), or from the environment when that file is absent:
#   MODE=docker  (default)  docker exec <CONTAINER> cscli ...; reload sends SIGHUP to the container
#   MODE=native             sudo cscli ...; reload runs systemctl reload crowdsec
#   CONTAINER=crowdsec      container name for docker mode (also CROWDSEC_CONTAINER)
#   CSCLI=/usr/bin/cscli    absolute path of cscli for native mode
#   SYSTEMCTL=/bin/systemctl
set -euo pipefail

conf="${HUB_EXEC_CONF:-/etc/crowdsec-hub/hub-exec.conf}"
mode="${HUB_EXEC_MODE:-docker}"
container="${CROWDSEC_CONTAINER:-crowdsec}"
cscli_bin="/usr/bin/cscli"
systemctl_bin="/bin/systemctl"

if [[ -r "$conf" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      MODE) if [[ "$value" == docker || "$value" == native ]]; then mode="$value"; fi ;;
      CONTAINER) if [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then container="$value"; fi ;;
      CSCLI) if [[ "$value" =~ ^/[A-Za-z0-9_./-]{1,100}$ ]]; then cscli_bin="$value"; fi ;;
      SYSTEMCTL) if [[ "$value" =~ ^/[A-Za-z0-9_./-]{1,100}$ ]]; then systemctl_bin="$value"; fi ;;
    esac
  done <"$conf"
fi

request="${SSH_ORIGINAL_COMMAND:-$*}"

log() { if command -v logger >/dev/null 2>&1; then logger -t hub-exec "$1" || true; fi; }

deny() {
  echo "hub-exec: denied: $1" >&2
  log "denied: $1"
  exit 126
}

[[ -n "$request" ]] || deny "empty request"
[[ "$request" =~ ^[A-Za-z0-9\ ._/-]{1,200}$ ]] || deny "unexpected characters"
read -r -a words <<<"$request"

valid_type() { [[ "$1" == scenarios || "$1" == collections || "$1" == parsers || "$1" == postoverflows ]]; }
valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$ && "$1" != *..* ]]; }

run_cscli() {
  if [[ "$mode" == native ]]; then
    exec sudo -n "$cscli_bin" "$@"
  fi
  exec docker exec "$container" cscli "$@"
}

case "${words[0]}" in
  hub-list)
    [[ ${#words[@]} -eq 1 ]] || deny "hub-list takes no arguments"
    run_cscli hub list -a -o json
    ;;
  hub-update)
    [[ ${#words[@]} -eq 1 ]] || deny "hub-update takes no arguments"
    log "hub update"
    run_cscli hub update
    ;;
  upgrade-all)
    [[ ${#words[@]} -eq 1 ]] || deny "upgrade-all takes no arguments"
    log "hub upgrade (all)"
    run_cscli hub upgrade
    ;;
  install|remove|upgrade)
    [[ ${#words[@]} -eq 3 ]] || deny "${words[0]} needs a type and a name"
    valid_type "${words[1]}" || deny "unknown type"
    valid_name "${words[2]}" || deny "invalid name"
    log "${words[0]} ${words[1]} ${words[2]}"
    run_cscli "${words[1]}" "${words[0]}" "${words[2]}"
    ;;
  reload)
    [[ ${#words[@]} -eq 1 ]] || deny "reload takes no arguments"
    log "reload"
    if [[ "$mode" == native ]]; then
      exec sudo -n "$systemctl_bin" reload crowdsec
    fi
    exec docker kill --signal=SIGHUP "$container"
    ;;
  *)
    deny "unknown request"
    ;;
esac
