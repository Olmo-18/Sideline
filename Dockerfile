FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/var/data PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
