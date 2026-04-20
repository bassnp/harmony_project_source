#!/bin/sh
# Healthcheck probe for Docker HEALTHCHECK directive.
# Returns 0 if the /api/health endpoint responds with HTTP 2xx, 1 otherwise.
curl -fsS http://127.0.0.1:3031/api/health || exit 1
