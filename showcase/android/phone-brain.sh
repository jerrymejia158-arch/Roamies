#!/usr/bin/env bash
# The Roamies brain running on the phone itself, in Termux. This is the experiment that answers "does the brain
# start on Android's Node at all": no app is involved, the phone's Chrome talks to the brain's own phone bridge.
#   On the computer:  bundle the brain, add this script, send it over (docs/phone.md, "The brain on the phone").
#   In Termux:        pkg install -y nodejs-lts   then   bash phone-brain.sh
# The first run asks for an Anthropic API key (the phone can't use the Claude sign-in, which needs Claude Code).
set -u
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node isn't installed. Run: pkg install -y nodejs-lts"; exit 1; }
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 22 ] || { echo "Node $MAJOR is too old: the brain needs 22 or newer."; exit 1; }
[ -f sidekick.mjs ] || { echo "sidekick.mjs isn't beside this script."; exit 1; }
command -v termux-wake-lock >/dev/null && termux-wake-lock # keep Android from pausing it in the background

export ROAMIES_BRIDGE=local # the phone bridge, on this phone only (127.0.0.1)
KEYLINE=""
if ! grep -qs anthropic "$HOME/.gg/auth.json"; then
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
