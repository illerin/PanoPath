FROM node:20-alpine

# Install build deps for sharp (libvips) and heic-convert (libheif)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    vips-dev \
    libheif-dev \
    libjpeg-turbo-dev \
    libpng-dev

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source
COPY server/ ./server/
COPY public/ ./public/

# Create temp directories and set permissions
RUN mkdir -p /app/tmp/uploads /app/tmp/tiles && \
    addgroup -S panopath && \
    adduser -S panopath -G panopath && \
    chown -R panopath:panopath /app

USER panopath

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/ > /dev/null || exit 1

CMD ["node", "server/index.js"]
