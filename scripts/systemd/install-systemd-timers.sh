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
cp "$DIR/demo-reset.service" /etc/systemd/system/demo-reset.service
cp "$DIR/demo-reset.timer" /etc/systemd/system/demo-reset.timer

systemctl daemon-reload
# enable --now starts timers that aren't running yet; restart any that already
# are so schedule/unit edits take effect immediately on re-install.
systemctl enable --now simulator-run.timer demo-reset.timer
systemctl restart simulator-run.timer demo-reset.timer 2>/dev/null || true

echo "==> Installed. Status:"
systemctl status simulator-run.timer demo-reset.timer --no-pager || true
echo
echo "Next scheduled runs:"
systemctl list-timers simulator-run.timer demo-reset.timer --no-pager || true
echo
echo "Run the simulator once immediately with: sudo systemctl start simulator-run.service"
echo "Reset the demo immediately with:         sudo systemctl start demo-reset.service"
echo "Tail logs with:                          journalctl -u simulator-run.service -f"
echo "                                          journalctl -u demo-reset.service -f"
