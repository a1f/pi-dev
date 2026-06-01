# VM setup checklist

One-time provisioning of the dev VM that hosts `pi-dev`. This replaces the
per-session Docker container — the VM itself is now the security boundary,
so the hardening that was previously in the Dockerfile / compose / iptables
init script lives here.

Target: one persistent VM (Proxmox / KVM / whatever), accessed over SSH.

## Recommended specs

Minimum for comfortable pi use:
- 2 vCPU (4 if running multiple parallel sessions)
- 4 GB RAM (8 GB nicer; pi + node + LLM streaming)
- 20 GB disk (most goes to npm cache + sessions + worktrees)
- 1 NIC, bridged or NAT, with internet egress

## Base OS

Debian 12 (Bookworm) or Ubuntu 24.04 LTS. The rest of this doc assumes
Debian-family `apt`.

## Step 1 — packages

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    ca-certificates curl git gnupg jq less ripgrep tmux nodejs npm
```

GitHub CLI (optional; for PR workflows later):
```sh
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list
sudo apt-get update && sudo apt-get install -y gh
```

## Step 2 — non-root user

Don't run pi as root.

```sh
sudo adduser pi --disabled-password --gecos ""
sudo usermod -aG sudo pi    # optional; revoke later
# Set up SSH key:
sudo mkdir -p /home/pi/.ssh
sudo cp ~/.ssh/authorized_keys /home/pi/.ssh/
sudo chown -R pi:pi /home/pi/.ssh
sudo chmod 700 /home/pi/.ssh
sudo chmod 600 /home/pi/.ssh/authorized_keys
```

From here on, everything runs as `pi` (`su - pi` or SSH in as `pi`).

## Step 3 — install pi

```sh
curl -fsSL https://pi.dev/install.sh | sh
# or pinned via npm:
sudo npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@0.78.0"
```

First-time auth (Codex/Claude/Copilot subscription):
```sh
pi /login
# follow the device-code flow; credentials land in ~/.pi/agent/auth.json
```

Or set provider API keys via `.env` in the pi-dev repo (see `.env.example`).

## Step 4 — clone pi-dev

```sh
mkdir -p ~/dev && cd ~/dev
git clone https://github.com/a1f/pi-dev
cd pi-dev
# Test:
./scripts/spawn.sh smoke
# (creates ../pi-dev-worktrees/smoke, exec's pi inside)
```

## Step 5 — egress allowlist (optional but recommended)

The container scaffold previously enforced a per-session iptables allowlist.
With a single VM, that lives at the VM level. Two ways to do it:

### Option A — nftables in the VM

`sudo nano /etc/nftables.conf`, replace with:

```nft
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
    set allowed_domains_v4 { type ipv4_addr; flags interval; }

    chain input  { type filter hook input  priority 0; policy drop;
        iif "lo" accept
        ct state { established, related } accept
        tcp dport 22 accept comment "SSH for the operator"
    }

    chain output { type filter hook output priority 0; policy drop;
        oif "lo" accept
        ct state { established, related } accept
        ip daddr @allowed_domains_v4 accept
        # DNS — pin to whatever your VM uses (check /etc/resolv.conf)
        ip daddr <YOUR-NAMESERVER> udp dport 53 accept
        ip daddr <YOUR-NAMESERVER> tcp dport 53 accept
    }
}
```

Then populate the set at boot from the same domain list the Docker scaffold
used (this script is git-recoverable at `container/init-firewall.sh` in
commit `dd7548a`):

```
LLM APIs:        api.anthropic.com, api.openai.com, generativelanguage.googleapis.com,
                 openrouter.ai, api.deepseek.com, api.x.ai, api.mistral.ai, api.groq.com
OAuth:           auth.openai.com, chatgpt.com, console.anthropic.com, claude.ai
Packages:        registry.npmjs.org, pi.dev
Git/GitHub:      github.com, api.github.com, codeload.github.com,
                 objects.githubusercontent.com, raw.githubusercontent.com
Web tools:       s.jina.ai, r.jina.ai
```

`Web tools` covers the `web_search` (s.jina.ai) and `web_read` (r.jina.ai)
extension. Omit the line if you don't use those tools; with it omitted and the
firewall on, the tools fail closed (connection timeout) rather than leaking.

`sudo systemctl enable --now nftables`.

#### Keeping the set fresh — CDN IP rotation

`allowed_domains_v4` is static: it holds the IPs you resolved when you populated
it. CDN-fronted hosts (Jina's `s.jina.ai` / `r.jina.ai` behind Cloudflare, and
several of the LLM APIs) rotate their IPs, so on a long-running VM the set goes
stale and requests start timing out even though the domain is "allowed".
Refresh it on a timer.

`/usr/local/sbin/refresh-allowlist.sh` (uses `getent`, so no `dig`/dnsutils
dependency):

```sh
#!/usr/bin/env bash
set -euo pipefail
DOMAINS=(
    api.anthropic.com api.openai.com generativelanguage.googleapis.com
    openrouter.ai api.deepseek.com api.x.ai api.mistral.ai api.groq.com
    auth.openai.com chatgpt.com console.anthropic.com claude.ai
    registry.npmjs.org pi.dev
    github.com api.github.com codeload.github.com
    objects.githubusercontent.com raw.githubusercontent.com
    s.jina.ai r.jina.ai
)
for d in "${DOMAINS[@]}"; do
    getent ahostsv4 "$d" | awk '{print $1}' | sort -u | while read -r ip; do
        nft add element inet filter allowed_domains_v4 "{ $ip }" 2>/dev/null || true
    done
done
```

It only *adds* IPs (never prunes) — stale entries are harmless, a missing entry
is what breaks things; a normal nftables reload flushes the set and the next
run repopulates it. Wire it to a systemd timer:

```ini
# /etc/systemd/system/refresh-allowlist.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/refresh-allowlist.sh

# /etc/systemd/system/refresh-allowlist.timer
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
```

```sh
sudo chmod +x /usr/local/sbin/refresh-allowlist.sh
sudo systemctl enable --now refresh-allowlist.timer
```

### Option B — Proxmox firewall

If you're on Proxmox, do this at the hypervisor level — set up an alias for
the allowlisted IPs in Datacenter → Firewall → Aliases, then attach a
firewall rule to the VM. Easier to manage; survives VM-internal changes.

There's no in-VM set to refresh here, so the CDN-rotation caveat above applies
at the alias level: pin the alias to the provider's published IP ranges where
available, or update it (manually or via the Proxmox API) on the same cadence.

## Step 6 — sysctl hardening (optional)

`sudo nano /etc/sysctl.d/10-pi-dev.conf`:

```
# Disable IPv6 (firewall is v4-only; v6 would bypass)
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1

# Standard server hardening
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.tcp_syncookies = 1
```

`sudo sysctl --system` (or reboot).

## Step 7 — verify

```sh
# Inside the VM as the pi user:
cd ~/dev/pi-dev
./scripts/spawn.sh smoke
# In pi: ask it something, confirm OAuth works.
# In a bash escape, confirm:
curl -sI https://chatgpt.com/        # should reach
curl -sI --max-time 5 https://example.com/   # should hang/fail if firewall is on
```

## Snapshot it

Once the VM passes verify, take a Proxmox snapshot. If pi or any extension
goes rogue (or just leaves crud lying around) you can roll back instantly
without rebuilding.

## What's deliberately NOT here

- Session-level isolation (bubblewrap, nsjail) — sessions trust each other in
  this setup. If you need cross-session isolation, run pi via `bwrap` from
  `spawn.sh` (separate change).
- Auto-update for pi — pin a version and bump deliberately. Renovate/
  Dependabot can watch `~/dev/pi-dev/scripts/spawn.sh` or this doc for the
  pinned version string.
