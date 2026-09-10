FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production \
    FHQ_DATA_DIR=/data \
    PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
