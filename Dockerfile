FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Penyelamat database: rclone untuk foto database ke Google Drive.
# Lihat docker-entrypoint.sh — aktif hanya bila env DB_BACKUP_REMOTE terisi.
ADD https://downloads.rclone.org/v1.69.1/rclone-v1.69.1-linux-amd64.deb /tmp/rclone.deb
RUN dpkg -i /tmp/rclone.deb && rm /tmp/rclone.deb && chmod +x /app/docker-entrypoint.sh
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
