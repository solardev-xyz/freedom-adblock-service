# syntax=docker/dockerfile:1

# ── Builder: install deps + compile adblock-rs (native Rust N-API) ──────────
# adblock-rs's postinstall runs `cargo build --release`, so this stage needs a
# Rust toolchain; the runtime stage does not. rust-toolchain.toml inside the
# adblock-rs package pins the exact channel, which rustup fetches on first use.
FROM node:22-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# ── Runtime: node + tsx only, no Rust ──────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# node_modules carries the compiled adblock-rs/js/index.node (same Debian glibc
# as the builder) plus tsx, which runs the .ts sources directly.
COPY --from=builder /app /app
ENV NODE_ENV=production

# Long-running publisher daemon. All config via env — see bin/serve.ts:
#   FEED_SIGNER_KEY (required), BEE_API_URL, STAMP_BATCH_ID,
#   BUILD_INTERVAL_HOURS (default 12), BATCH_TTL_FLOOR_DAYS (default 30)
CMD ["npm", "run", "serve:swarm"]
