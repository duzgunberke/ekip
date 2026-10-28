# ekip hub: job runner + control panel. Build: docker build -t ekip-hub .
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.312
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && mkdir -p /data \
  && chown node:node /data

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public

ENV NODE_ENV=production \
    PORT=7777 \
    EKIP_DATA=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    HOME=/home/node

USER node
VOLUME /data
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7777/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the claude/git subprocesses and forwards SIGTERM to node.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
