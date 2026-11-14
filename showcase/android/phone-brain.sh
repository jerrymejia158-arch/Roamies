#!/usr/bin/env bash
# The Roamies brain running on the phone itself, in Termux. This is the experiment that answers "does the brain
# start on Android's Node at all": no app is involved, the phone's Chrome talks to the brain's own phone bridge.
#   On the computer:  bundle the brain, add this script, send it over (docs/phone.md, "The brain on the phone").
#   In Termux:        pkg install -y nodejs-lts   then   bash phone-brain.sh
# With Claude Code installed and signed in in Termux, replies run through it on your Claude sign-in.
# Without it (or with --key), the first run asks for an Anthropic API key.
set -u
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node isn't installed. Run: pkg install -y nodejs-lts"; exit 1; }
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 22 ] || { echo "Node $MAJOR is too old: the brain needs 22 or newer."; exit 1; }
[ -f sidekick.mjs ] || { echo "sidekick.mjs isn't beside this script."; exit 1; }
command -v termux-wake-lock >/dev/null && termux-wake-lock # keep Android from pausing it in the background

export ROAMIES_BRIDGE=local # the phone bridge, on this phone only (127.0.0.1)
KEYLINE=""
AUTH="$HOME/.gg/auth.json"
if [ "${1:-}" != "--key" ] && command -v claude >/dev/null; then
  # A Claude Code installed in Termux: replies run through it, on the Claude sign-in it already has.
  if ! claude auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
    echo "Claude Code is installed but not signed in. Run:  claude   and sign in, then run this again."; exit 1
  fi
  export ROAMIES_CLAUDE_CODE="$(command -v claude)"
  # The brain's own note that Claude is signed in through Claude Code (the token stays with Claude Code).
  AUTH="$AUTH" node -e 'const fs = require("fs"), f = process.env.AUTH; let a = {}; try { a = JSON.parse(fs.readFileSync(f, "utf8")); } catch {} a["anthropic-claude-code"] = { via: "claude-code" }; fs.mkdirSync(require("path").dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(a, null, 2), { mode: 0o600 });'
  echo "Using Claude Code at $ROAMIES_CLAUDE_CODE with your Claude sign-in."
elif ! grep -qs '"anthropic"' "$AUTH"; then
  [ "${1:-}" = "--key" ] || echo "No Claude Code found in Termux, so this needs an Anthropic API key."
  read -rsp "Paste your Anthropic API key, then press Enter (it won't show): " KEY; echo
  # The same message the setup guide sends when a key is typed there.
  KEYLINE=$(KEY="$KEY" node -e 'process.stdout.write(JSON.stringify({ type: "ob_apikey", provider: "anthropic", key: process.env.KEY.trim() }))')
fi

echo "Starting the brain: Node $(node -v) on $(node -p 'process.platform + " " + process.arch')"
# The brain reads its shell's messages on stdin and stops when stdin closes, so it is held open.
( [ -n "$KEYLINE" ] && echo "$KEYLINE"; exec tail -f /dev/null ) | node sidekick.mjs > brain-out.log &
BRAIN=$!
for _ in $(seq 1 25); do
  sleep 1
  kill -0 "$BRAIN" 2>/dev/null || break
  grep -qs bridge_listening "$HOME"/.gg/sidekick/logs/*.log && break
done
if ! kill -0 "$BRAIN" 2>/dev/null; then echo; echo "THE BRAIN STOPPED. The lines above say why."; exit 1; fi
if ! grep -qs bridge_listening "$HOME"/.gg/sidekick/logs/*.log; then echo; echo "The brain is running, but its phone bridge did not start. Last log lines:"; tail -n 5 "$HOME"/.gg/sidekick/logs/*.log; fi
echo
echo "THE BRAIN IS RUNNING ON THIS PHONE."
echo "Pairing code:  $(node -p 'JSON.parse(require("fs").readFileSync(process.env.HOME + "/.gg/sidekick/bridge.json", "utf8")).token' 2>/dev/null)"
echo "Open in Chrome on this phone:  http://127.0.0.1:3917/"
echo "Leave Termux open. Ctrl+C stops the brain."
wait "$BRAIN"
