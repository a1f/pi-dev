#!/usr/bin/env bash
# Container entrypoint.
#
# Runs as root. Sets up the egress firewall (which requires CAP_NET_ADMIN),
# then drops privileges to the `pi` user before exec'ing the actual command.
# Capabilities don't survive the user switch, so pi runs without any.
#
# Set PI_DISABLE_FIREWALL=1 to skip firewall init (useful for debugging
# the agent itself when you want unrestricted egress).

set -euo pipefail

if [[ "${PI_DISABLE_FIREWALL:-0}" == "1" ]]; then
    echo "[entrypoint] PI_DISABLE_FIREWALL=1 — skipping firewall init" >&2
else
    /usr/local/bin/init-firewall.sh
fi

# Drop to pi. The "$@" carries the compose `command:` (default: `pi`) or
# whatever arguments spawn.sh forwarded. No explicit group: pi's primary
# group is set at useradd time (matches host GID), and on Debian GID 20
# already maps to `dialout`, so a "pi" group by name may not exist.
exec gosu pi "$@"
