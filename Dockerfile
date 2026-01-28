FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (git for policyengine-uk, HDF5 for tables)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libhdf5-dev \
    pkg-config \
    build-essential \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy everything needed for install
COPY pyproject.toml uv.lock* ./
COPY src/ ./src/

# Install dependencies and the package
RUN uv sync --frozen --no-dev || uv sync --no-dev

# Cloud Run uses PORT env var
ENV PORT=8080

EXPOSE 8080

# Run with uvicorn
CMD ["uv", "run", "uvicorn", "uk_budget_data.api:app", "--host", "0.0.0.0", "--port", "8080"]
