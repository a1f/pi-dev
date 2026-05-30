# pi-dev development container
#
# Runs the pi coding agent (@earendil-works/pi-coding-agent) inside a minimal
# Node 22 environment. Paired with a bind-mount of the host repo (the worktree)
# at the same absolute path as on host, so git worktree references resolve
# naturally.
#
# Boot sequence: container starts as root → entrypoint sets up the egress
# firewall (iptables + ipset) → gosu drops to the `pi` user → exec pi.

FROM node:22-slim

# Host UID/GID forwarded at build time so files written through the bind mount
# end up owned by the host user (matters on Linux; on macOS Docker Desktop
# remaps anyway, but setting it doesn't hurt).
ARG UID=501
ARG GID=20
ARG PI_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive

# Base tooling pi needs at runtime + tooling needed by the firewall init:
#   git, ripgrep, jq, tmux, less   — pi/agent runtime
#   gnupg                          — gh apt key
#   iptables, ipset, dnsutils      — firewall init (dig resolves the allowlist)
#   gosu                           — entrypoint drops root → pi cleanly
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dnsutils \
        git \
        gnupg \
        gosu \
        iptables \
        ipset \
        jq \
        less \
        ripgrep \
        tmux \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI from the official apt source (not used by initial scaffold but
# pre-installed so PR-flavored skills work later without rebuild).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Install pi globally.
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"

# Non-root user. The GID may already exist (e.g. GID 20 = `dialout` on Debian);
# reuse it if so, otherwise create our own group. The user itself is what
# `gosu` switches to in the entrypoint — we don't `USER pi` here because the
# entrypoint needs to start as root to apply firewall rules.
RUN if ! getent group "${GID}" >/dev/null; then groupadd -g "${GID}" pi; fi \
 && useradd -m -u "${UID}" -g "${GID}" -s /bin/bash pi \
 && mkdir -p /home/pi/.cache /home/pi/.npm /home/pi/.pi \
 && chown -R "${UID}:${GID}" /home/pi

# Container scripts.
COPY container/entrypoint.sh    /usr/local/bin/entrypoint.sh
COPY container/init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/init-firewall.sh

ENV HOME=/home/pi
WORKDIR /home/pi

# Stays as root so the firewall can be applied. The entrypoint drops to pi
# via gosu before exec'ing the actual command.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pi"]
