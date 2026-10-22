#!/bin/sh
# Proxy entrypoint: the nginx error-log boundary (ADR-0062).
#
# nginx 1.28 writes the request line, upstream URI and referrer of a request it fails into its error log, query
# string included, and no directive changes that format. So nginx never gets the container's stderr. Its stderr is a
# FIFO in a private directory whose only reader is the sanitizer, and the sanitizer writes rebuilt, allow-listed
# lines to the real stderr. If the sanitizer stops, nginx is stopped too. Nothing falls back to raw lines.
set -eu

fifo_dir=/run/nginx-error-log
fifo="$fifo_dir/stderr"
sanitizer=/usr/local/lib/nginx-error-log/sanitizer.mjs
drain_tenths=50

# Fixed words only, in the sanitizer's own line format.
notice() {
  echo "nginx-error-log: event=$*" >&2
}

if [ "$#" -ne 0 ]; then
  notice "unsupported_arguments"
  exit 64
fi

# Render the site template (the base image's entrypoint scripts), then validate the result before anything listens.
# No request exists yet, so `nginx -t` reports straight to the container's stderr: configuration errors stay
# readable, and they hold configuration, never traffic.
/docker-entrypoint.sh nginx -t -q

rm -rf "$fifo_dir"
mkdir -m 0700 "$fifo_dir"
mkfifo -m 0600 "$fifo"

nginx_pid=
sanitizer_state=running
stopping=

forward() {
  if [ -n "$nginx_pid" ]; then kill "-$1" "$nginx_pid" 2>/dev/null || true; fi
}
# An exited nginx that is not yet reaped still answers `kill -0`; its state is Z.
nginx_running() {
  state=$(cut -d ' ' -f 3 "/proc/$nginx_pid/stat" 2>/dev/null) || return 1
  [ -n "$state" ] && [ "$state" != Z ]
}
# Docker stops the image with QUIT (graceful). TERM and INT are nginx's fast shutdown, HUP its reload.
trap 'forward QUIT' QUIT
trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'forward HUP' HUP
# How the sanitizer ended: USR1 at the end of its input, USR2 for anything else.
trap 'sanitizer_state=ended' USR1
trap 'sanitizer_state=failed' USR2

# The sanitizer ignores stop signals so that it can drain nginx's last entries. It ends by itself at end of input,
# once every nginx process has closed the FIFO. It writes to the container's stderr; its own diagnostics are
# discarded, because an njs error report could quote input.
(
  trap '' HUP INT QUIT TERM
  if njs -n QuickJS -m "$sanitizer" <"$fifo" >&2 2>/dev/null; then kill -USR1 $$; else kill -USR2 $$; fi
) &

nginx -g 'daemon off;' 2>"$fifo" &
nginx_pid=$!

# A trapped signal interrupts `wait`; nginx is gone once `kill -0` fails, and that `wait` returned its status. The
# shell's own job report ("Terminated") is discarded: it is not a line the sanitizer built.
while :; do
  if [ "$sanitizer_state" != running ] && [ -z "$stopping" ] && nginx_running; then
    stopping=1
    notice "sanitizer_stopped action=stopping_nginx"
    kill -TERM "$nginx_pid" 2>/dev/null || true
  fi
  status=0
  wait "$nginx_pid" 2>/dev/null || status=$?
  if ! kill -0 "$nginx_pid" 2>/dev/null; then break; fi
done

# Bounded drain of what nginx wrote last.
tenths=0
while [ "$sanitizer_state" = running ] && [ "$tenths" -lt "$drain_tenths" ]; do
  sleep 0.1
  tenths=$((tenths + 1))
done

if [ "$sanitizer_state" = running ]; then
  notice "sanitizer_drain_timeout"
  exit 70
fi
if [ -n "$stopping" ] || [ "$sanitizer_state" = failed ]; then
  exit 70
fi
exit "$status"
