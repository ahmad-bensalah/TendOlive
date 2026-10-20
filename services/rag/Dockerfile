# RAG service (FastAPI, port 8001), started like app.py does. Build context: services/rag.
# Layout inside: /app/rag (this folder) and /app/data (the knowledge base, bind-mounted from knowledge-base/ by
# docker-compose.yml). The code reads the CVs at ../data/cvs relative to this folder, so /app/data is that place;
# RAG_DATA_DIR=/app/data says it explicitly for the other folders.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUTF8=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/hf-cache \
    ANONYMIZED_TELEMETRY=False \
    RAG_DATA_DIR=/app/data

COPY requirements.txt /tmp/rag-requirements.txt
# CPU-only PyTorch first (the default Linux wheel pulls ~3 GB of CUDA libraries), then the RAG requirements
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install -r /tmp/rag-requirements.txt \
 && rm /tmp/rag-requirements.txt

# The embedding model and the reranker (rag/config.py defaults), downloaded once here: app.py then finds them in the cache
# and runs with HF_HUB_OFFLINE=1 (no Hugging Face call at start)
RUN python -c "from sentence_transformers import SentenceTransformer, CrossEncoder; \
SentenceTransformer('intfloat/multilingual-e5-small'); CrossEncoder('cross-encoder/mmarco-mMiniLMv2-L12-H384-v1'); print('models cached')" \
 && chmod -R a+rX /opt/hf-cache

COPY . /app/rag/
WORKDIR /app/rag

EXPOSE 8001
# --host 0.0.0.0: reachable from the other containers; --no-browser: nothing to open in a container
CMD ["python", "app.py", "--host", "0.0.0.0", "--port", "8001", "--no-browser"]
