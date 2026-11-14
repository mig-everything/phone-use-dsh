#!/bin/sh
set -eu
# The portable plugin manifest requires a bare command or a path within the plugin.
# Installation pins the local Node executable through the environment, not command.
exec "${PHONE_USE_NODE:-node}" "$@"
