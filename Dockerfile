# Surfing Dog Inbox, the Node build, as one small image: ghcr.io/surfingdogai/inbox.
#
#   (umask 077; echo "INBOX_SECRET_KEY=$(openssl rand -base64 32)" > inbox.env)   # keep a copy somewhere safe
#   docker run -d --name inbox -p 127.0.0.1:8787:8787 -v inbox-data:/opt/inbox/data --env-file inbox.env \
#     -e INBOX_OWNER_EMAIL=you@yourbusiness.com -e INBOX_PUBLIC_URL=https://inbox.yourbusiness.com \
#     ghcr.io/surfingdogai/inbox:0.2.0
#
# It answers on the server itself only, over plain HTTP: put a proxy with TLS in front (one that drops
# a CF-Connecting-IP the caller sent), or use deploy/docker-compose.yml, which has Caddy.
#
# Or build it from this repository: `docker build -t surfingdog-inbox .`. The release workflow builds
# it for amd64 and arm64 on every version tag. The same steps as the Node install guide
# (surfingdog.ai/install.md): the single-file server and the owner app in /opt/inbox, run as the user
# `inbox` (uid 10001), the SQLite file in /opt/inbox/data. With no configuration at all it serves the
# public API and the MCP server at /mcp; everything else is an -e away: INBOX_PUBLIC_URL,
# INBOX_OWNER_EMAIL, INBOX_SECRET_KEY…  deploy/ has the Compose file with HTTPS, and the installer.

# The build is JavaScript, the same on every machine, so it runs once on the builder's own platform,
# and only the small last stage is made for each architecture.
# Both bases are pinned by digest; Dependabot proposes each new one.
FROM --platform=$BUILDPLATFORM node:25.9.0-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @surfingdog/inbox build

FROM node:25.9.0-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Surfing Dog Inbox" \
  org.opencontainers.image.description="An inbox for the bookings, orders, quote requests and messages that people and their AI agents send a business." \
  org.opencontainers.image.source="https://github.com/surfingdogai/inbox" \
  org.opencontainers.image.url="https://surfingdog.ai/install/" \
  org.opencontainers.image.documentation="https://surfingdog.ai/docs/run-it-yourself/" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.vendor="Surfing Dog" \
  org.opencontainers.image.version="$VERSION" \
  org.opencontainers.image.revision="$REVISION"
# A fixed uid and gid, so a folder on the host can be given to the inbox before it starts.
RUN addgroup -S -g 10001 inbox \
  && adduser -S -D -H -u 10001 -G inbox -h /opt/inbox -s /sbin/nologin inbox \
  && mkdir -p /opt/inbox/data \
  && chown inbox:inbox /opt/inbox/data \
  && chmod 700 /opt/inbox/data
WORKDIR /opt/inbox
COPY --from=build /src/apps/inbox/dist/server.mjs /opt/inbox/server.mjs
COPY --from=build /src/apps/inbox/dist/client /opt/inbox/client
COPY apps/inbox/docker/start.mjs /opt/inbox/start.mjs
ENV INBOX_DB=/opt/inbox/data/inbox.db \
  INBOX_STATIC=/opt/inbox/client \
  HOST=0.0.0.0 \
  PORT=8787
USER 10001:10001
VOLUME ["/opt/inbox/data"]
EXPOSE 8787
# Healthy means the database answers too (/healthz runs a query). Checked every two seconds while it
# starts, then every thirty.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/opt/inbox/start.mjs"]
