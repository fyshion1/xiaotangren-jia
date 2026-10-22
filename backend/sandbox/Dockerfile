# Build explicitly: docker build -t xiaotangren-sandbox:local backend/sandbox
# Runtime always resolves this local image to its immutable sha256 ID, never pulls.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
USER 65534:65534
WORKDIR /work
