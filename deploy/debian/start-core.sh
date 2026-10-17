#!/bin/sh
set -eu
runtime_config=$(/opt/mihomo-manager/node/bin/node /opt/mihomo-manager/app/deploy/debian/startup-config.mjs)
exec "$MIHOMO_BINARY_PATH" -d "$MIHOMO_DATA_DIR" -f "$runtime_config" -ext-ctl 127.0.0.1:19090
