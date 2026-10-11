# Remote folders over SSH

**File → Open Remote Folder** (Ctrl+Alt+O on Windows/Linux, ⌘⇧O on macOS) opens a folder on another machine through your system `ssh`. You can pick a host from `~/.ssh/config` or type `user@host` / `user@host:port`.

SparkDown uses your normal SSH setup: `~/.ssh/config`, your keys, and your agent. It **never asks for the server password**.

## Host keys (first connect)

The first time you connect to a host that isn't in your `known_hosts` yet, SparkDown:

1. reads the host's public keys with `ssh-keyscan`, using the HostName, Port and HostKeyAlias that `ssh` would use for that host.
2. shows each key's type and **SHA256 fingerprint**, and waits for you to decide. Nothing is accepted silently.
3. if you click **Trust and connect**, appends exactly those keys to your `known_hosts`, as `host` or `[host]:port` and hashed if `HashKnownHosts` is on, then connects with ssh's normal strict checking.

Compare the fingerprints with the ones on the server before you trust them:

```sh
# on the server
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Hosts behind `ProxyJump` / `ProxyCommand` can't be scanned directly. For those, run `ssh <host>` once in a terminal to check and accept the key, then connect from SparkDown.

### "The host key has CHANGED"

If the server's key no longer matches the one in your `known_hosts`, SparkDown refuses to connect and doesn't offer to replace the key. This is how a man-in-the-middle attack looks. It's also what happens after a server is reinstalled. Confirm with the server's administrator. Only if the change is expected, remove the old entry and connect again:

```sh
ssh-keygen -R example.com            # default port
ssh-keygen -R '[example.com]:2222'   # other ports
```

## Passphrase-protected keys

If your key has a passphrase, ssh needs either an **SSH agent** that holds the unlocked key, or a way to ask you for the passphrase. When no agent holds it, SparkDown says:

> Your key needs an SSH agent: run ssh-add and relaunch SparkDown.

Load the key into your agent:

```sh
ssh-add ~/.ssh/id_ed25519
```

Then relaunch SparkDown. It picks up the agent (`SSH_AUTH_SOCK`) from the environment it was started in.

- **Linux:** an app started from the launcher only sees `SSH_AUTH_SOCK` if your session exports it. Typical setups:
  - a systemd user agent, with `SSH_AUTH_SOCK` set in `~/.config/environment.d/` (or `~/.config/uwsm/env` on uwsm/Hyprland sessions such as Omarchy).
  - `gcr-ssh-agent` (`systemctl --user enable --now gcr-ssh-agent.socket`), with `SSH_AUTH_SOCK=${XDG_RUNTIME_DIR}/gcr/ssh` in `~/.config/environment.d/`.

  An agent started from `~/.bashrc` (for example `eval $(ssh-agent)` or keychain) only exists in terminals, not in apps started from the launcher.
- **macOS:** the system agent is always available. To store the passphrase in the Keychain, run `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`.
- **Windows:** start the OpenSSH agent service once from an elevated PowerShell (`Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent`), then run `ssh-add`. Windows `ssh.exe` finds the agent on its own; no environment variable is needed.
