#!/usr/bin/env bash
# install-systemd-timers.sh — install/enable the simulator-run systemd timer
# on this host. Idempotent: safe to re-run after updating the unit files.
#
# Usage: sudo ./scripts/systemd/install-systemd-timers.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo (systemd units need to be copied to /etc/systemd/system)." >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cp "$DIR/simulator-run.service" /etc/systemd/system/simulator-run.service
cp "$DIR/simulator-run.timer" /etc/systemd/system/simulator-run.timer

systemctl daemon-reload
systemctl enable --now simulator-run.timer

echo "==> Installed. Status:"
systemctl status simulator-run.timer --no-pager || true
echo
echo "Next scheduled run:"
systemctl list-timers simulator-run.timer --no-pager || true
echo
echo "Run it once immediately with: sudo systemctl start simulator-run.service"
echo "Tail logs with:               journalctl -u simulator-run.service -f"
