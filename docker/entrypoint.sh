#!/bin/sh
# serve  (default)  run the queue with its headless browser
# login             a window on a virtual screen, shown over VNC on port 5900, to sign in to each site once
# anything else     passed to the CLI (for example: status, add <url>)
set -e
cd /app
case "${1:-serve}" in
  serve)
    node cli/mediasaver.mjs browser setup
    exec node cli/mediasaver.mjs serve
    ;;
  login)
    export DISPLAY=:99
    Xvfb :99 -screen 0 1280x900x24 &
    sleep 2
    node cli/mediasaver.mjs browser setup --headed
    node cli/mediasaver.mjs browser login
    echo "Connect a VNC client to port 5900, sign in to the sites, then stop this container."
    exec x11vnc -display :99 -forever -nopw -listen 0.0.0.0 -rfbport 5900
    ;;
  *)
    exec node cli/mediasaver.mjs "$@"
    ;;
esac
