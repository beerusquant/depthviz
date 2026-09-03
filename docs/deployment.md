# Deployment

[← README](../README.md) · [Architecture](architecture.md) · [Verification](verification.md) · [Deployment](deployment.md) · [Adding an exchange](adding-an-exchange.md)

## On a VPS

It runs behind systemd on a small VPS — one unit, `PORT` and `HOST` from the
environment, nothing else. The deployed directory is deliberately **not a git
checkout**: a deploy is a `git diff` of the local commits, copied over and
applied with `git apply`, then `systemctl restart` and a look at `journalctl`.

Two habits are worth stealing. Never rsync the tree: a patch that does not apply
is telling you the target has drifted, and an overwrite destroys that
information. And after deploying, confirm the tree matches the commit by
**comparing per-file hashes** — a service that starts is not proof that the code
you meant to ship is the code running.

The service listens on loopback and the firewall carries no rule for its port,
so it is not reachable from the internet. Reach it over an SSH tunnel:

```bash
ssh -L 8888:127.0.0.1:8888 <your-host>     # then http://127.0.0.1:8888
```

Install devDependencies on the host too (`npm install --include=dev`) and every
check in [docs/verification.md](verification.md) runs there as well.

## Reaching it from a browser, without thinking about it

The service listens on loopback on the VPS, so a browser needs an SSH tunnel.
Typing one every time is how a tool stops being used, so macOS keeps it up:
`deploy/install-mac.sh` sets it up.

```bash
DEPTHVIZ_SSH_HOST=my-vps ./deploy/install-mac.sh
```

It renders `deploy/depthviz-tunnel.plist.template` and the launcher with your
host, ports and home directory, then loads the agent. Nothing in the repo
carries those values — they are substituted at install time.

It forwards `8888:127.0.0.1:8888` to your host, starts at login and, with
`KeepAlive`, comes back on its own after a network drop, a wake from sleep or a
kill — verified by killing the process and watching a new pid serve HTTP 200
twelve seconds later. `ServerAliveInterval=30` / `CountMax=3` is what notices a
connection that died without closing. Then **`http://127.0.0.1:8888`** always
works; bookmark it.

The same script installs `deploy/Depthviz.app.template` as a launcher app in
`~/Applications`, so it shows up in Spotlight, so ⌘-Space → "depth" → Enter
opens the chart. It checks the tunnel first and, if the agent was stopped or the
Mac has just woken, restarts it and waits before opening the browser — from a
fully torn-down state it takes ~5 s. It says so in an alert rather than opening
a dead page when the VPS itself is unreachable.

Requires a passphrase-less key (or one loaded outside the agent): a LaunchAgent
has no terminal to prompt on. Remove with
`launchctl bootout gui/$(id -u)/dev.depthviz.tunnel`, and read
`~/Library/Logs/depthviz-tunnel.log` if it ever stops.
