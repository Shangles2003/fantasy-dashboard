#!/bin/sh
set -e
mkdir -p "${FHQ_DATA_DIR:-/data}"
chown -R node:node "${FHQ_DATA_DIR:-/data}"
exec su-exec node "$@"
