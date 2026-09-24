# Surfing Dog Inbox, the Node build, as one small image.
#
#   docker build -t surfingdog-inbox .
#   docker run -p 8787:8787 -v inbox-data:/opt/inbox/data surfingdog-inbox
#
# The same steps as the Node install guide (surfingdog.ai/install.md, path B): build the single-file
# server and the owner app, put both in /opt/inbox, run as the user `inbox`, keep the SQLite file in
# /opt/inbox/data. With no configuration at all it serves the public API and the MCP server at /mcp.
# Everything else in the guide is an -e away: INBOX_PUBLIC_URL, INBOX_OWNER_EMAIL, INBOX_SECRET_KEY…

FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @surfingdog/inbox build

FROM node:24-slim
RUN groupadd --system inbox \
  && useradd --system --gid inbox --home-dir /opt/inbox --shell /usr/sbin/nologin inbox \
  && mkdir -p /opt/inbox/data \
  && chown inbox:inbox /opt/inbox/data
WORKDIR /opt/inbox
COPY --from=build /src/apps/inbox/dist/server.mjs /opt/inbox/server.mjs
COPY --from=build /src/apps/inbox/dist/client /opt/inbox/client
ENV INBOX_DB=/opt/inbox/data/inbox.db \
  INBOX_STATIC=/opt/inbox/client \
  HOST=0.0.0.0 \
  PORT=8787
USER inbox
VOLUME ["/opt/inbox/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/opt/inbox/server.mjs"]
