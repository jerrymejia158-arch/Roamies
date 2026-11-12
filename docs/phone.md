# Roamies on a phone (piggyback mode)

The phone shows the Roamie, hears you and speaks; the brain stays on your computer. The phone page is served by
the brain itself and talks to it over a WebSocket (`showcase/tauri/sidecar/bridge.mjs`).

## Turn it on (on the computer)

The bridge is off unless `ROAMIES_BRIDGE` is set when Roamies starts.

| `ROAMIES_BRIDGE` | Listens on |
| --- | --- |
| `local` | `127.0.0.1` only. Use with `tailscale serve` (below). |
| `tailscale` | This computer's Tailscale address (`100.x.y.z`) only. |
| anything else | Refused: the bridge never listens on a LAN or public address. |

`ROAMIES_BRIDGE_PORT` changes the port (default 3917).

The pairing code is made on first start and kept in `~/.gg/sidekick/bridge.json` (set `ROAMIES_BRIDGE_TOKEN`
to choose your own, 16 characters or more).

## Open it (on the phone)

Speech recognition and the microphone need HTTPS in a phone browser. With Tailscale on both devices:

```sh
# on the computer, once: HTTPS on your tailnet name, forwarded to the bridge on loopback
tailscale serve --bg 3917
```

Then open `https://<computer>.<tailnet>.ts.net/` on the phone, type the pairing code, and add the page to the
home screen. Typing works over plain `http://100.x.y.z:3917/` too (`ROAMIES_BRIDGE=tailscale`); talking does not.

## What a phone request can and can't do

A request from the phone runs in the same brain, with the same memory and reminders, and its reply (text and
voice) goes back to the phone only. It cannot use the tools that act on the computer's own screen, apps or disk:
`take_screenshot`, `list_windows`, `read_window`, `act_in_app`, `draw`, `see_photo`, `run_command`, `write_file`,
`open`. A phone can only send these messages: `ask`, `voice`, `answer`, `stop`, `ui_ready`, `reply_said`.

Voice in uses the phone browser's speech recognition. In Chrome on Android that sends audio to Google, unlike
the computer's own on-device recognition.

## Not yet

- Reminders fire on the computer only; the phone sees them once it has its own brain and sync.
- The floating creature over other apps, and tapping in apps for you, need the Android app.
