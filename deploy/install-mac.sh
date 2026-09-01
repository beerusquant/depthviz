#!/bin/zsh
# Install the macOS side: a LaunchAgent that holds the SSH tunnel to the host
# running depthviz, and a launcher app so the chart is one Spotlight search away.
#
#   DEPTHVIZ_SSH_HOST=my-vps ./deploy/install-mac.sh
#
# Nothing here is committed with your values in it: the host, the ports and your
# home directory are substituted at install time. Uninstall with
#   launchctl bootout gui/$(id -u)/dev.depthviz.tunnel && rm -rf ~/Applications/Depthviz.app
set -eu

HOST="${DEPTHVIZ_SSH_HOST:-}"
PORT="${DEPTHVIZ_PORT:-8888}"          # local port you will open in the browser
REMOTE_PORT="${DEPTHVIZ_REMOTE_PORT:-8888}"   # port depthviz listens on, on the host
LABEL="dev.depthviz.tunnel"

if [ -z "$HOST" ]; then
  echo "DEPTHVIZ_SSH_HOST is required — the ssh alias or user@host running depthviz." >&2
  echo "  e.g. DEPTHVIZ_SSH_HOST=my-vps $0" >&2
  exit 2
fi

# A LaunchAgent has no terminal to prompt on, so the key must open unattended.
if ! env -u SSH_AUTH_SOCK ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" true 2>/dev/null; then
  echo "ssh $HOST does not work without an agent — a LaunchAgent cannot type a passphrase." >&2
  exit 3
fi

here="${0:a:h}"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Applications"

sed -e "s|@LABEL@|$LABEL|g" -e "s|@SSH_HOST@|$HOST|g" \
    -e "s|@PORT@|$PORT|g" -e "s|@REMOTE_PORT@|$REMOTE_PORT|g" \
    -e "s|@HOME@|$HOME|g" \
    "$here/depthviz-tunnel.plist.template" > "$HOME/Library/LaunchAgents/$LABEL.plist"
plutil -lint "$HOME/Library/LaunchAgents/$LABEL.plist" >/dev/null

rm -rf "$HOME/Applications/Depthviz.app"
cp -R "$here/Depthviz.app.template" "$HOME/Applications/Depthviz.app"
sed -i '' -e "s|@PORT@|$PORT|g" -e "s|@LABEL@|$LABEL|g" \
    "$HOME/Applications/Depthviz.app/Contents/MacOS/depthviz"
chmod +x "$HOME/Applications/Depthviz.app/Contents/MacOS/depthviz"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist"

echo "tunnel agent $LABEL -> $HOST, forwarding localhost:$PORT"
echo "open http://127.0.0.1:$PORT, or ⌘-Space \"Depthviz\""
