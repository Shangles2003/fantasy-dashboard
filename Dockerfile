FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY . .
ENV NODE_ENV=production \
    FHQ_DATA_DIR=/data \
    PORT=8080
EXPOSE 8080
# Fix ownership of the data volume, then run the app as the unprivileged "node" user
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
