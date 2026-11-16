FROM mcr.microsoft.com/devcontainers/javascript-node:5.2.6-24-bookworm

USER root

# Native Node.js/SQLite modules, database inspection, and debugging utilities.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        iproute2 \
        jq \
        libsqlite3-dev \
        lsof \
        netcat-openbsd \
        openssl \
        pkg-config \
        procps \
        python3 \
        ripgrep \
        shellcheck \
        sqlite3 \
        unzip \
        xauth \
        zip \
    && rm -rf /var/lib/apt/lists/*

# Bootstrap tools are independent of the future application's dependencies.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PATH="/opt/screensvr-tooling/node_modules/.bin:${PATH}"

COPY tooling/package.json tooling/package-lock.json /opt/screensvr-tooling/

RUN cd /opt/screensvr-tooling \
    && npm ci --no-audit --no-fund \
    && ./node_modules/.bin/playwright install --with-deps chromium firefox webkit \
    && chown -R node:node /ms-playwright \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY tooling/check-browsers.mjs /opt/screensvr-tooling/check-browsers.mjs

# Login shells prepend the base image's global npm bin directory to PATH.
# Remove its duplicate linter so the locked bootstrap version always wins.
RUN npm uninstall --global eslint \
    && npm cache clean --force

USER node
