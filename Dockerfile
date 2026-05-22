FROM node:22-alpine
WORKDIR /app

# Build deps for native modules + curl/sqlite for runtime
RUN apk add --no-cache python3 make g++ sqlite curl ca-certificates bash glibc-compat 2>/dev/null \
 || apk add --no-cache python3 make g++ sqlite curl ca-certificates bash

# Install Eclipse Temurin JDK 25 (Adoptium). Alpine packages lag behind Mojang's
# class file version requirements (1.21.6+ ships class version 69 = Java 25).
ENV JAVA_HOME=/opt/jdk
ENV PATH=$JAVA_HOME/bin:$PATH
RUN ARCH=$(uname -m); \
    case "$ARCH" in \
      x86_64) JDK_ARCH=x64 ;; \
      aarch64) JDK_ARCH=aarch64 ;; \
      *) echo "Unsupported arch: $ARCH"; exit 1 ;; \
    esac; \
    URL="https://api.adoptium.net/v3/binary/latest/25/ga/alpine-linux/${JDK_ARCH}/jre/hotspot/normal/eclipse?project=jdk"; \
    mkdir -p /opt/jdk && cd /tmp && \
    curl -fsSL -o jdk.tar.gz "$URL" && \
    tar -xzf jdk.tar.gz -C /opt/jdk --strip-components=1 && \
    rm jdk.tar.gz && \
    java -version

# bore: free TCP-tunnel client (https://github.com/ekzhang/bore). Used to give
# each MC server its own real public host:port (bore.pub:<port>) for free.
RUN ARCH=$(uname -m); \
    case "$ARCH" in \
      x86_64) BORE_ARCH=x86_64-unknown-linux-musl ;; \
      aarch64) BORE_ARCH=aarch64-unknown-linux-musl ;; \
      *) echo "Unsupported arch: $ARCH"; exit 1 ;; \
    esac; \
    BORE_VER=0.5.3; \
    curl -fsSL -o /tmp/bore.tar.gz "https://github.com/ekzhang/bore/releases/download/v${BORE_VER}/bore-v${BORE_VER}-${BORE_ARCH}.tar.gz" && \
    tar -xzf /tmp/bore.tar.gz -C /usr/local/bin/ && \
    rm /tmp/bore.tar.gz && \
    chmod +x /usr/local/bin/bore && \
    bore --version

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p data backups uploads jars

EXPOSE 4000 25565
ENV NODE_ENV=production \
    MC_PORT=25565

CMD ["node", "backend/server.js"]
