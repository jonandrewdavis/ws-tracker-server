# ws-tracker-server

A websocket based tracking server to support Godot client connections. Announces available sessions to be joined with the Tube Godot add-on:

- Tube: https://github.com/koopmyers/tube
- Using your own servers: https://github.com/koopmyers/tube?tab=readme-ov-file#using-your-own-servers
- bittorrent-tracker: https://github.com/webtorrent/bittorrent-tracker (websocket session tracker used in this project)
  - NOTE: This project has no real relation to "bittorrent". It's simply simple session tracker that helps announce clients.
  - In this case, it's used as a lightweight "Signaling Server" in WebRTC.
  - Once a Godot Multiplayer Peer-to-Peer session is established using `WebRTCMultiplayerPeer`, the session deslists and disconnects from this websockets server.
  - https://docs.godotengine.org/en/4.4/classes/class_webrtcmultiplayerpeer.html#class-webrtcmultiplayerpeer

### Local Development

This project was set up using `wrangler`. You may need to set the version of yarn to stable for Cloudflare build.

```
yarn set version stable
```

Install

```
yarn install
```

Run (NOTE: You may need the `.dev.vars` secrets file)

```
yarn start
```

- The websocket server will be available at `ws://localhost:8787`.
- In Godot: Use the local websocket url in the `tube_context_dev.tres` resource in your Godot client.
- In Godot: Create an empty scene with a `TubeInspector`
  - (Tube will always use local signaling, but the inspector allows you to see if your tracker is working)

### Deployment

Cloudflare can connect to github and detect changes to `main` to build the project. Importing as a "Worker" in cloudflare is an easy way to get started. You can also deploy from local

```
yarn deploy
```

#### Secrets

These are stored in the `.dev.vars` and set at the time of creation of the worker.

- `SECRET_KEY`: The secret key used to authenticate requests.
- `TURN_KEY`: The turn key used to authenticate requests.

### NOTES & TODO

- Additional filtering of connections, reject those without `SECRET_KEY`
- TURN Server (for fall back to relay, in the case of locked down networks (most commonly university networks) also via cloudflare. Just a matter of adding a route)
- Matchmaking
  - Pairing sessions effectively, deterministically
  - May need a message queue, dead-letter queue, and retry, etc
  - Expect this to be a bit of an interesting challenge
