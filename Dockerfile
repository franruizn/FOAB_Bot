# syntax=docker/dockerfile:1

# ---- deps: instala SOLO dependencias de producción, en su propia capa ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: imagen final, sin devDependencies, usuario no-root ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

# UID/GID fijos (no autogenerados) para poder documentar el chown del volumen
# en el README sin que dependa de qué asigne cada build.
RUN addgroup -g 1001 -S foab && adduser -u 1001 -S foab -G foab

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src

# /data es el punto de montaje del volumen (ver docker-compose.yml). Se crea
# y se da ownership aquí para que, si Docker inicializa el volumen a partir
# del contenido de la imagen, quede con el dueño correcto desde el principio.
RUN mkdir -p /data && chown -R foab:foab /app /data

USER foab

CMD ["node", "src/index.js"]
