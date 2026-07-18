# aws-sdk-s3 (R2 archive) requires rustc >= 1.94
FROM rust:1.96-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/messaging-relayer ./messaging-relayer

EXPOSE 3000

# Match runtime PORT; $$ becomes $ in HEALTHCHECK CMD so sh expands PORT at probe time.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=5s \
    CMD curl -sf "http://127.0.0.1:$${PORT:-3000}/health_check" >/dev/null || exit 1

CMD ["./messaging-relayer"]
