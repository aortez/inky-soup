# Development/testing Dockerfile that mirrors production paths.
FROM rust:1.85-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release

# Runtime image.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create inky user to match production.
RUN useradd -m -s /bin/bash inky

# Set up directory structure matching production.
WORKDIR /usr/share/inky-soup

COPY --from=builder /build/target/release/upload-server /usr/bin/inky-soup-server
COPY templates ./templates

# Copy static files except images (images come from /data volume).
COPY --chown=inky:inky static/js ./static/js
COPY --chown=inky:inky static/chota.min.css static/favicon.ico ./static/

# Create data directories (will be mounted as volume in production).
RUN mkdir -p /data/inky-soup/images/cache \
             /data/inky-soup/images/thumbs \
             /data/inky-soup/images/dithered \
             /data/inky-soup/images/metadata \
    && chown -R inky:inky /data/inky-soup

# Match production environment.
ENV ROCKET_ADDRESS=0.0.0.0
ENV ROCKET_PORT=8000
ENV ROCKET_TEMPLATE_DIR=/usr/share/inky-soup/templates
ENV INKY_SOUP_IMAGES_DIR=/data/inky-soup/images

USER inky
EXPOSE 8000

CMD ["/usr/bin/inky-soup-server"]
