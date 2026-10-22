FROM python:3.11-slim

WORKDIR /workspace/backend

# 依赖清单与构建
COPY backend/pyproject.toml backend/uv.lock ./
COPY packages/tool-runtime /workspace/packages/tool-runtime
RUN pip install --no-cache-dir "uv" && uv sync --locked

COPY backend/app ./app
COPY backend/sandbox/personal-docs ./sandbox/personal-docs

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
