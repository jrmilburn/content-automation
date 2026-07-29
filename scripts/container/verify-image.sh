#!/usr/bin/env bash
# Verifies the supply-chain properties a runtime image must hold: it never runs
# as root, it records the exact Node.js and media-tool versions it shipped with,
# and it declares a health command.
set -euo pipefail

image="${1:?usage: verify-image.sh <image> <web|worker>}"
target="${2:?usage: verify-image.sh <image> <web|worker>}"

expected_node="$(tr -d '[:space:]' <.node-version)"

fail() {
  echo "verify-image: $1" >&2
  exit 1
}

configured_user="$(docker image inspect --format '{{.Config.User}}' "$image")"
[ -n "$configured_user" ] || fail "$image declares no USER and would run as root."
[ "$configured_user" != "root" ] && [ "$configured_user" != "0" ] ||
  fail "$image is configured to run as root."

runtime_uid="$(docker run --rm "$image" node --print 'process.getuid()')"
[ "$runtime_uid" != "0" ] || fail "$image runs as uid 0."

has_healthcheck="$(docker image inspect --format '{{if .Config.Healthcheck}}yes{{else}}no{{end}}' "$image")"
[ "$has_healthcheck" = "yes" ] || fail "$image declares no HEALTHCHECK."

# Read through the image WORKDIR rather than an absolute path so the script also
# runs from a Windows shell, where an absolute path would be rewritten on the way in.
build_info="$(docker run --rm "$image" cat build-info.json)"

recorded_node="$(printf '%s' "$build_info" | node --print 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).node')"
[ "$recorded_node" = "$expected_node" ] ||
  fail "$image records Node.js $recorded_node but .node-version pins $expected_node."

if [ "$target" = "worker" ]; then
  for tool in ffmpeg ffprobe; do
    recorded_tool="$(printf '%s' "$build_info" |
      node --print "JSON.parse(require('node:fs').readFileSync(0, 'utf8')).${tool} ?? ''")"
    [ -n "$recorded_tool" ] || fail "$image does not record its $tool version."
    echo "verify-image: $target $tool $recorded_tool"
  done
fi

echo "verify-image: $target ok (user=$configured_user uid=$runtime_uid node=$recorded_node healthcheck=yes)"
