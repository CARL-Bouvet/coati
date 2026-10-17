#!/usr/bin/env bash
# Registers the Native Messaging host for a source checkout (Brave only, or --all /
# --uninstall). See dev-native-host.ts.
exec bun "$(dirname "$0")/dev-native-host.ts" "$@"
