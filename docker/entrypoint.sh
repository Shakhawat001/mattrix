#!/bin/sh
# One image, two jobs. `web` checks its configuration, applies database migrations and then
# serves the dashboard.
# `worker` is the background process that reads Shopify. Anything else runs as given.
set -e

case "$1" in
  web)
    # Stop at once, with a plain list, if the configuration is wrong.
    node dist/cli.mjs check-env
    node dist/cli.mjs migrate
    exec node server.js
    ;;
  worker)
    exec node dist/worker.mjs
    ;;
  *)
    exec "$@"
    ;;
esac
