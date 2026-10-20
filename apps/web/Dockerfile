# The web app (React + Vite), built here and served by nginx, which also proxies /api, /retrieve and /health to the RAG
# service like the Vite dev proxy (vite.config.ts). Build context: apps/web.
FROM node:20-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
# the browser calls the proposal studio and n8n directly, on the HOST ports
ARG VITE_STUDIO_URL=http://localhost:8091
ARG VITE_N8N_URL=http://localhost:5679
ENV VITE_STUDIO_URL=$VITE_STUDIO_URL VITE_N8N_URL=$VITE_N8N_URL
# tsc -b (type check) then vite build
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80
