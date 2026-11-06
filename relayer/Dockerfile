# aws-sdk-s3 (R2 archive) requires rustc >= 1.94
FROM rust:1.96-bookworm AS builder

# Build context is the repo root: the relayer depends on the sibling `mls` crate (path = "../mls").
#   docker build -f relayer/Dockerfile .
WORKDIR /app/relayer

COPY mls/Cargo.toml mls/uniffi-bindgen.rs /app/mls/
COPY mls/src /app/mls/src

COPY relayer/Cargo.toml relayer/Cargo.lock ./
COPY relayer/migrations ./migrations
COPY relayer/src ./src

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/relayer/target/release/messaging-relayer ./messaging-relayer

EXPOSE 3000

# Match runtime PORT; $$ becomes $ in HEALTHCHECK CMD so sh expands PORT at probe time.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=5s \
    CMD curl -sf "http://127.0.0.1:$${PORT:-3000}/health_check" >/dev/null || exit 1

CMD ["./messaging-relayer"]
