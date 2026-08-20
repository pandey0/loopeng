#!/bin/sh
set -e

# Runs as root (the image's default USER) so it can fix up ownership of
# volumes/bind-mounts that land root-owned by default, then re-execs the real
# command as the non-root `node` user -- see Dockerfile.api's comment on why
# this container can't just run as root outright (the claude CLI refuses
# --dangerously-skip-permissions under root).
mkdir -p /repo/apps/api/data/agent-logs
chown -R node:node /repo/apps/api/data

# Docker auto-creates a bind mount's missing parent directories as root when
# only a single file inside them is mounted -- here, CLAUDE_CREDENTIALS_HOST_PATH
# lands at /home/node/.claude/.credentials.json (docker-compose.yml), so
# /home/node/.claude itself comes up root-owned even though `node` is the
# user that actually needs to write into it. Confirmed live: the claude CLI's
# own Bash tool failed entirely with "mkdir '/home/node/.claude/session-env':
# permission denied" -- it needs to create its own session-state files
# alongside the mounted credentials file, not just read them. Only the
# directory itself needs fixing (non-recursive) -- .credentials.json is a
# separate read-only mount, not something to chown.
mkdir -p /home/node/.claude
chown node:node /home/node/.claude

# -s /bin/sh -c 'exec "$0" "$@"' -- "$@" preserves the exact argv passed to
# this script (CMD's ["pnpm", "start"]) instead of re-flattening it through a
# shell string, which would mangle any argument containing whitespace/quotes.
exec su node -s /bin/sh -c 'exec "$0" "$@"' -- "$@"
