FROM python:3.11-slim

WORKDIR /app

# 依赖清单与构建
COPY pyproject.toml ./
RUN pip install --no-cache-dir "uv" && uv sync

COPY app ./app

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]