#!/usr/bin/env bash
# Removes everything the Web UI pairing installer added to this server: the SSH
# key and its dedicated user, the executor wrapper, its sudo rule and its settings.
# CrowdSec itself, and the scenarios installed through the Web UI, are left alone.
set -euo pipefail

conf="/etc/crowdsec-hub/hub-exec.conf"
lib_dir="/usr/local/lib/crowdsec-hub"

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root, for example: sudo $lib_dir/uninstall.sh" >&2
  exit 1
fi

hub_user=""
created_user=0
if [[ -r "$conf" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      USER) if [[ "$value" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then hub_user="$value"; fi ;;
      CREATED_USER) if [[ "$value" == 1 ]]; then created_user=1; fi ;;
    esac
  done <"$conf"
fi

if [[ -n "$hub_user" ]] && id "$hub_user" >/dev/null 2>&1; then
  home_dir="$(getent passwd "$hub_user" | cut -d: -f6)"
  if [[ -n "$home_dir" && -f "$home_dir/.ssh/authorized_keys" ]]; then
    sed -i '/crowdsec-web-ui-hub/d' "$home_dir/.ssh/authorized_keys"
  fi
  if [[ "$created_user" == 1 ]]; then
    userdel --remove "$hub_user" >/dev/null 2>&1 || userdel "$hub_user" || true
    echo "Removed user $hub_user"
  else
    echo "Kept user $hub_user (it existed before the installer ran)"
  fi
fi

rm -f /etc/sudoers.d/crowdsec-hub
rm -rf /etc/crowdsec-hub
echo "Removed the Web UI hub executor. In the Web UI, choose Remove server on the Scenarios page."
rm -rf "$lib_dir"
