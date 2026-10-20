# Proposal studio (the teammate's rfp-studio) exactly as he wrote it: Python server.py on 8091, Node for his agents' CLI
# mode and tests, Playwright Chromium for template previews and PDF export.
# Build context: services/proposal-studio. Extra context "n8n" (docker-compose.yml): n8n/llm.json, the LLM provider table.
# Only this Dockerfile, docker-entrypoint.sh and .dockerignore were added to his folder.
FROM node:20-bookworm-slim AS node

FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUTF8=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Node 20 (agents/tools/generate.js in GENERATE_MODE=cli, the agents' node tests; no npm dependencies)
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app/studio
COPY requirements.txt /tmp/studio-requirements.txt
# python-pptx, qrcode, pillow, lxml, pymupdf, playwright (pinned in requirements.txt), then Chromium and its system
# libraries, and common fonts so exported PDFs and previews do not all fall back to one font
RUN pip install -r /tmp/studio-requirements.txt \
 && playwright install --with-deps chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-liberation2 fonts-noto-core \
 && rm -rf /var/lib/apt/lists/* /tmp/studio-requirements.txt

COPY --from=n8n llm.json /opt/rfp/llm.json
COPY docker-entrypoint.sh /opt/rfp/studio-entrypoint.sh
RUN sed -i 's/\r$//' /opt/rfp/studio-entrypoint.sh && chmod 755 /opt/rfp/studio-entrypoint.sh
# his files, unchanged (the runtime folders are volumes, see docker-compose.yml)
COPY . /app/studio/

EXPOSE 8091
ENTRYPOINT ["/opt/rfp/studio-entrypoint.sh"]
