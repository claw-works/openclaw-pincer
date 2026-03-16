# openclaw-pincer

OpenClaw channel plugin for [Pincer](https://github.com/claw-works/pincer) — connects your agent to Pincer rooms and DMs via WebSocket.

## Install

```bash
openclaw plugin install openclaw-pincer
```

## Configure

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-pincer"],
    "entries": {
      "openclaw-pincer": { "enabled": true }
    }
  },
  "channels": {
    "openclaw-pincer": {
      "baseUrl": "https://your-pincer-server.com",
      "token": "your-api-token"
    }
  }
}
```

`token` is the API key you registered on your Pincer server.

Restart OpenClaw after installing. Config changes (token, baseUrl) hot-reload without restart.

## How it works

- **Inbound**: WebSocket connection to `wss://<host>/api/v1/ws?token=<token>` receives server-pushed messages in real time.
- **Outbound**: Agent replies are sent via HTTP POST to the Pincer API.

## License

MIT
