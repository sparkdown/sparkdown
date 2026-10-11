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

If your key has a passphrase and no SSH agent holds it, SparkDown asks for it in a dialog:

- The dialog names the key file (for example `~/.ssh/id_ed25519`). Type that key's passphrase, **not** the server password. SparkDown never asks for, and ssh is never allowed to ask for, a server password: password and keyboard-interactive authentication are turned off for SparkDown's connections and only public-key authentication is tried.
- **Cancel** stops the connection ("no passphrase was entered for your SSH key").
- A wrong passphrase asks again, the way `ssh` does in a terminal. If every attempt fails, SparkDown says the passphrase was wrong or the server did not accept the key.

### How it works and what is kept

ssh runs SparkDown's own binary as its `SSH_ASKPASS` program (`SSH_ASKPASS_REQUIRE=force`, so no terminal is involved). That helper only answers prompts of the form `Enter passphrase for key '…':` (and ssh's "Bad passphrase, try again for …" re-prompt). It refuses anything else, such as `password:` prompts, host-key yes/no questions or security-key PINs, by exiting with an error.

The helper fetches the passphrase from the running app over a private channel created for each remote connection: on Linux and macOS a Unix socket inside a `0700` temporary directory (socket mode `0600`); on Windows a named pipe that only the current user can open. Each connection has a random one-time token that the helper must present. The passphrase never goes into environment variables, command-line arguments, files, logs or settings.

Cache policy: after a successful unlock, the passphrase stays in memory **for that remote session only**, in a buffer that is wiped when it is dropped (Rust `zeroize`). It is reused only when ssh asks again for the same key during the session (for example after a dropped connection, or on Windows, where ssh cannot share one connection). Disconnecting, switching hosts or quitting SparkDown wipes it. It is never written to disk. A passphrase that ssh rejects is dropped at once and you are asked again.

### Using an SSH agent instead

An agent avoids the dialog entirely. If SparkDown can't run its prompt (for example with an old ssh), it falls back to saying:

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

### ssh versions

- OpenSSH 8.4 and newer honour `SSH_ASKPASS_REQUIRE=force`. Older versions use the askpass program only when `DISPLAY` is set, so SparkDown gives its ssh processes a placeholder `DISPLAY` when none exists (X11 forwarding is turned off for them).
- Windows: the OpenSSH that ships with Windows 11 22H2/23H2 is 8.6p1, and Windows 11 24H2 (and Windows 10 after the October 2024 update) ships 9.5p1; both support `SSH_ASKPASS_REQUIRE` ([Win32-OpenSSH 8.6.0.0p1-Beta release notes](https://github.com/PowerShell/Win32-OpenSSH/releases/tag/V8.6.0.0p1-Beta), [#1726](https://github.com/PowerShell/Win32-OpenSSH/issues/1726)). Older Windows 10 builds ship 8.1p1, which uses `SSH_ASKPASS` without the `REQUIRE` variable ([#2115](https://github.com/PowerShell/Win32-OpenSSH/issues/2115)). If the dialog never appears on Windows, use the agent instead (above). Check your version with `ssh -V`.
