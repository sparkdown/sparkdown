//! In-app SSH key passphrase prompt (#27).
//!
//! When a remote connect needs a passphrase-protected key that no agent
//! holds, ssh asks its `SSH_ASKPASS` program. SparkDown points that at its
//! own binary (askpass mode, see `main`) with `SSH_ASKPASS_REQUIRE=force`,
//! and only on its own ssh calls, which also carry
//! `PasswordAuthentication=no`, `KbdInteractiveAuthentication=no` and
//! `PreferredAuthentications=publickey`: the server password can never be
//! asked for. `BatchMode=no` is required (BatchMode disables askpass).
//!
//! The helper process gets the passphrase from the running app over a
//! local IPC endpoint made for this remote connection (the [`Broker`]):
//!
//! - Unix: a socket in a fresh 0700 directory, the socket itself 0600.
//! - Windows: a named pipe whose DACL allows only the current user (and
//!   SYSTEM), the same descriptor as the MCP pipe.
//!
//! The helper presents a random ticket passed in its environment
//! (`SPARKDOWN_ASKPASS_TOKEN`): the broker mints a fresh ticket for every ssh
//! child it spawns and tracks attempt counts per ticket. A given ticket stays
//! valid for the ssh child's lifetime with a small attempt cap, so a
//! wrong-passphrase retry works. On Unix the broker also verifies the peer
//! uid matches the running app.
//!
//! The broker answers only while an ssh call that SparkDown started is
//! running (see [`Broker::pending_guard`]). When the last such call ends, every
//! outstanding ticket is dropped, so a ticket left in the environment of a
//! lingering ssh process (a kept-open control connection) is of no use later.
//!
//! The passphrase itself never goes into env, argv, files, logs or config:
//! it travels app → helper over the IPC, and helper → ssh over the
//! helper's stdout pipe (the askpass contract).
//!
//! Both sides answer only key-passphrase prompts ([`classify_prompt`]);
//! anything else (a password, a host-key yes/no, a PIN, an unknown prompt)
//! is refused and the helper exits non-zero.
//!
//! Lifetime: the passphrase is held in `Zeroizing` buffers (wiped on drop)
//! and cached per key for the remote session only, so a dropped control
//! connection (or Windows, which has no SSH connection sharing) can
//! re-authenticate without asking again. The cache dies with the broker
//! (disconnect, next connect, app exit). It is never written to disk.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

/// Env var naming the broker's IPC endpoint (also the askpass-mode switch).
pub const ENV_IPC: &str = "SPARKDOWN_ASKPASS_IPC";
/// Env var carrying the helper's per-connection ticket (fresh per ssh spawn,
/// valid for the ssh session with a small attempt cap).
pub const ENV_TOKEN: &str = "SPARKDOWN_ASKPASS_TOKEN";

/// Protocol tag; bump on any wire change.
const MAGIC: &str = "SDASK1";
/// Longest prompt or passphrase accepted on the wire.
const MAX_LEN: usize = 4096;
/// A repeat ask for the same key this soon after an answer is ssh retrying a
/// wrong passphrase: drop the cached one and ask the user again.
const RETRY_WINDOW: Duration = Duration::from_secs(15);
/// A minted ticket is accepted at most this long after it was handed to an
/// ssh child. Matches the helper's IPC read timeout: if ssh hasn't invoked
/// the askpass helper within this window, it never will.
const TICKET_TTL: Duration = Duration::from_secs(300);
/// A hard cap on outstanding (unconsumed, unexpired) tickets.
const MAX_TICKETS: usize = 32;
/// A given ticket is accepted at most this many times. Allows a
/// wrong-passphrase retry (OpenSSH invokes the askpass helper again in the
/// same ssh process after a wrong answer).
const MAX_TICKET_ATTEMPTS: usize = 5;
/// How long a connected peer gets to send its request (header and prompt).
/// The real helper sends both at once right after it connects. The wait for
/// the user's answer is separate and is not bounded by this.
const SERVE_TIMEOUT: Duration = Duration::from_secs(5);

// --- Prompt classifier ------------------------------------------------------

/// The key path if `prompt` is an OpenSSH key-passphrase prompt, else None.
///
/// Accepted (OpenSSH's own wording):
/// - `Enter passphrase for key '<path>': ` (ssh, sshconnect2.c)
/// - `Enter passphrase for <path>: ` (ssh-add)
/// - `Bad passphrase, try again for <path>: ` (ssh-add retry)
///
/// Everything else is refused: password prompts, host-key confirmations,
/// security-key PINs, multi-line or unknown text.
pub fn classify_prompt(prompt: &str) -> Option<String> {
    let p = prompt.trim_end();
    if p.is_empty() || p.len() > MAX_LEN || p.contains(['\n', '\r', '\0']) {
        return None;
    }
    let lower = p.to_ascii_lowercase();
    if lower.contains("password") || lower.contains("yes/no") || lower.contains(" pin ") {
        return None;
    }
    let body = p.strip_suffix(':')?;
    let path = if let Some(rest) = body.strip_prefix("Enter passphrase for key '") {
        rest.strip_suffix('\'')?
    } else if let Some(rest) = body.strip_prefix("Enter passphrase for ") {
        rest
    } else {
        body.strip_prefix("Bad passphrase, try again for ")?
    };
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// Constant-time token comparison.
pub fn tokens_match(expected: &[u8], got: &[u8]) -> bool {
    if expected.len() != got.len() || expected.is_empty() {
        return false;
    }
    expected
        .iter()
        .zip(got)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// 256 random bits as hex from the OS CSPRNG: `/dev/urandom` on Unix,
/// `BCryptGenRandom` on Windows via [`crate::mcp::os_random_bytes`]. Fails
/// closed when the OS RNG is unavailable rather than falling back to a
/// non-cryptographic hasher.
pub fn new_token() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 32];
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            if f.read_exact(&mut buf).is_ok() {
                return buf.iter().map(|b| format!("{b:02x}")).collect();
            }
        }
        // No urandom: delegate to the shared OS-CSPRNG path, which panics
        // if no CSPRNG is reachable instead of degrading to a hasher.
    }
    fallback_token()
}

fn fallback_token() -> String {
    let mut buf = [0u8; 32];
    crate::mcp::os_random_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// --- Wire protocol ------------------------------------------------------------
//
// helper → app: "SDASK1 <token> <prompt_len>\n<prompt bytes>"
// app → helper: "OK <len>\n<passphrase bytes>"  or  "NO\n"

/// Reads from `inner` until `until`, then fails with `TimedOut`, so a peer
/// that sends a byte at a time cannot hold the listener past the limit.
struct ReadDeadline<'a, R: Read> {
    inner: &'a mut R,
    until: Instant,
}

impl<R: Read> Read for ReadDeadline<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if Instant::now() >= self.until {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        self.inner.read(buf)
    }
}

fn read_line_capped<R: Read>(r: &mut R, cap: usize) -> Option<String> {
    let mut out = Vec::new();
    let mut b = [0u8; 1];
    while out.len() < cap {
        match r.read(&mut b) {
            Ok(1) if b[0] == b'\n' => return String::from_utf8(out).ok(),
            Ok(1) => out.push(b[0]),
            _ => return None,
        }
    }
    None
}

fn read_exact_vec<R: Read>(r: &mut R, len: usize) -> Option<Zeroizing<Vec<u8>>> {
    if len > MAX_LEN {
        return None;
    }
    let mut buf = Zeroizing::new(vec![0u8; len]);
    r.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// Peer verification hook used by the listener before serving a request.
///
/// Implementations are platform-specific: on Unix, SO_PEERCRED gives the
/// peer's effective uid; on Windows the pipe DACL restricts callers to the
/// current user. The per-connection ticket is the primary check; this one
/// is an additional condition on the caller.
trait PeerVerify {
    fn verify_peer(&self, broker: &Broker) -> bool;
}

fn verify_peer<S: PeerVerify>(s: &S, broker: &Broker) -> bool {
    #[cfg(test)]
    if broker
        .refuse_peers
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return false;
    }
    s.verify_peer(broker)
}

#[cfg(unix)]
impl PeerVerify for std::os::unix::net::UnixStream {
    fn verify_peer(&self, _broker: &Broker) -> bool {
        // SO_PEERCRED (Linux) and getpeereid (macOS/BSD) give the connecting
        // peer's effective uid. Refuse on lookup failure.
        same_user(peer_uid(self), current_uid())
    }
}

/// The peer may talk to the broker only when its uid was read and equals ours.
#[cfg(unix)]
fn same_user(peer: Option<u32>, ours: u32) -> bool {
    peer == Some(ours)
}

#[cfg(windows)]
impl PeerVerify for interprocess::local_socket::Stream {
    fn verify_peer(&self, _broker: &Broker) -> bool {
        // The pipe's DACL already restricts callers to the current user +
        // SYSTEM; a stricter per-request check would require a HANDLE we
        // don't currently expose from `interprocess`. Leave the per-connection
        // ticket as the authoritative check for now.
        true
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: `geteuid` is always available and takes no arguments.
    unsafe { libc::geteuid() as u32 }
}

#[cfg(all(unix, target_os = "linux"))]
fn peer_uid(s: &std::os::unix::net::UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: fd is valid for the lifetime of `s`; pointers and sizes
    // match the libc declaration of SO_PEERCRED on Linux.
    let r = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if r == 0 && len as usize == std::mem::size_of::<libc::ucred>() {
        Some(cred.uid as u32)
    } else {
        None
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn peer_uid(s: &std::os::unix::net::UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: fd is valid for the lifetime of `s`; getpeereid is BSD/
    // macOS-portable and writes exactly one uid/gid out.
    let r = unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) };
    if r == 0 {
        Some(uid as u32)
    } else {
        None
    }
}

/// Server side of one helper connection. Returns what to answer.
///
/// Callers must have already verified the peer with [`verify_peer`] (on
/// the raw socket type) before entering this generic function.
///
/// Holds the broker only while it asks it something, so a connection that
/// stops talking does not keep a dropped broker (its cached passphrases and
/// its endpoint) around.
fn serve_request<S: Read + Write>(stream: &mut S, broker: &Weak<Broker>) {
    let reply_no = |s: &mut S| {
        let _ = s.write_all(b"NO\n");
        let _ = s.flush();
    };
    let request = {
        let mut incoming = ReadDeadline {
            inner: &mut *stream,
            until: Instant::now() + SERVE_TIMEOUT,
        };
        (|| {
            let head = read_line_capped(&mut incoming, 256)?;
            let mut parts = head.split(' ');
            let (Some(MAGIC), Some(token), Some(len), None) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            else {
                return None;
            };
            let b = broker.upgrade()?;
            // Answer only while an ssh call that SparkDown started is running.
            if !b.is_pending() {
                return None;
            }
            // A ticket is valid for one session. `take_ticket` validates the
            // ticket, enforces the attempt cap, and returns the allowlist of
            // local identity files its ssh child may ask for.
            let allowed = b.take_ticket(token)?;
            drop(b);
            let len = len.parse::<usize>().ok()?;
            let prompt = read_exact_vec(&mut incoming, len)?;
            Some((allowed, prompt))
        })()
    };
    let Some((allowed, prompt)) = request else {
        return reply_no(stream);
    };
    let Ok(prompt) = std::str::from_utf8(&prompt) else {
        return reply_no(stream);
    };
    // Verify the prompt classification on the broker side.
    let Some(b) = broker.upgrade() else {
        return reply_no(stream);
    };
    let Some(key) = classify_prompt(prompt) else {
        b.refused.store(true, std::sync::atomic::Ordering::SeqCst);
        return reply_no(stream);
    };
    // Require the prompt-named path to be one of the identity files this
    // ssh child was authorised for at mint time. The prompt text is
    // server-chosen (sshd sets it for SSH_MSG_USERAUTH_INFO_REQUEST), so
    // this is the only place the request is tied back to a local key file.
    // Canonicalising both sides defeats `..`/symlink/whitespace tricks and
    // requires the file to exist locally.
    let Some(requested) = canonical_key(Path::new(&key)) else {
        b.note_refused_key(&key);
        return reply_no(stream);
    };
    if !allowed.contains(&requested) {
        b.note_refused_key(&key);
        return reply_no(stream);
    }
    // Connections are served side by side; the passphrase prompt is shown
    // for one at a time.
    let answer = {
        let _one = b.answering.lock().unwrap_or_else(|e| e.into_inner());
        b.passphrase_for(&key)
    };
    drop(b);
    match answer {
        Some(pass) => {
            let mut msg = Zeroizing::new(format!("OK {}\n", pass.len()).into_bytes());
            msg.extend_from_slice(pass.as_bytes());
            let _ = stream.write_all(&msg);
            let _ = stream.flush();
        }
        None => reply_no(stream),
    }
}

/// Client side (the helper): ask the app for `prompt`'s passphrase.
fn request<S: Read + Write>(
    stream: &mut S,
    token: &str,
    prompt: &str,
) -> Option<Zeroizing<Vec<u8>>> {
    let head = format!("{MAGIC} {token} {}\n", prompt.len());
    stream.write_all(head.as_bytes()).ok()?;
    stream.write_all(prompt.as_bytes()).ok()?;
    stream.flush().ok()?;
    let line = read_line_capped(stream, 32)?;
    let len = line.strip_prefix("OK ")?.parse::<usize>().ok()?;
    read_exact_vec(stream, len)
}

// --- Helper (askpass mode of the SparkDown binary) ----------------------------

/// Whether this process was started by ssh as SparkDown's askpass helper.
///
/// Both askpass env vars present means helper mode, whatever `argv[1]` is:
/// `helper_main` / `classify_prompt` then decline anything that is not a
/// key-passphrase prompt (exit 1). `argv[1]` is the prompt text, which can
/// come from the server (keyboard-interactive, a ProxyJump host), so a
/// prompt starting with `--` must not be read as a SparkDown command line.
pub fn is_helper_invocation() -> bool {
    std::env::var_os(ENV_IPC).is_some() && std::env::var_os(ENV_TOKEN).is_some()
}

/// Entry point of askpass mode: print the passphrase for argv[1]'s prompt to
/// stdout and exit 0, or exit 1 for anything that is not a key-passphrase
/// prompt or that the app declines.
pub fn helper_main() -> i32 {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    if classify_prompt(&prompt).is_none() {
        return 1;
    }
    let (Some(ipc), Ok(token)) = (std::env::var_os(ENV_IPC), std::env::var(ENV_TOKEN)) else {
        return 1;
    };
    let Some(pass) = helper_request(&ipc, &token, &prompt) else {
        return 1;
    };
    let mut out = std::io::stdout().lock();
    let mut line = Zeroizing::new(pass.to_vec());
    line.push(b'\n');
    if out.write_all(&line).is_err() || out.flush().is_err() {
        return 1;
    }
    0
}

#[cfg(unix)]
fn helper_request(ipc: &std::ffi::OsStr, token: &str, prompt: &str) -> Option<Zeroizing<Vec<u8>>> {
    let mut s = std::os::unix::net::UnixStream::connect(ipc).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(300)));
    request(&mut s, token, prompt)
}

#[cfg(windows)]
fn helper_request(ipc: &std::ffi::OsStr, token: &str, prompt: &str) -> Option<Zeroizing<Vec<u8>>> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
    let name = ipc.to_fs_name::<GenericFilePath>().ok()?;
    let mut s = Stream::connect(name).ok()?;
    request(&mut s, token, prompt)
}

// --- Broker (app side) -----------------------------------------------------------

/// Asks the user for `key`'s passphrase (None = cancelled / timed out).
/// Asks the user for `key`'s passphrase. The flag is true when ssh asked
/// again right after the last answer, i.e. that passphrase was wrong (#52).
pub type Provider = Arc<dyn Fn(&str, bool) -> Option<Zeroizing<String>> + Send + Sync>;

/// A key's cached passphrase and, while ssh may still be checking it, the
/// time it was handed out (inside the retry window a re-ask means "wrong").
type CachedPass = (Zeroizing<String>, Option<Instant>);

/// A minted ticket's state: when it was issued, how many times it was used,
/// and the canonicalised set of local identity files its ssh child may ask
/// for. An empty list means the ticket accepts no key path; callers pass
/// the destination's identity files.
struct Ticket {
    issued: Instant,
    attempts: usize,
    /// Canonicalised paths of the identity files ssh would try for this
    /// destination. Only files that existed locally at mint time are kept;
    /// anything else is dropped.
    allowed_keys: Vec<PathBuf>,
}

/// Canonicalise `p` for comparison, following symlinks. Returns `None` when
/// the file does not exist locally: a path the local filesystem cannot
/// resolve is never an allowed key.
fn canonical_key(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

/// What happened with askpass during one connect attempt (#50).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// An askpass endpoint was up, so ssh could ask for a key passphrase.
    pub ready: bool,
    /// The user dismissed the passphrase prompt.
    pub cancelled: bool,
    /// A passphrase was handed to ssh.
    pub answered: bool,
    /// ssh's askpass request was refused (not a key passphrase prompt).
    pub refused: bool,
    /// The key file a refused request named, when it was a passphrase
    /// prompt for a key that is not one of the destination's identity files.
    pub refused_key: Option<String>,
}

/// Keeps the broker answering helper requests while an ssh call runs; see
/// [`Broker::pending_guard`].
pub struct PendingGuard(Arc<Broker>);

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.0.close_pending();
    }
}

/// One remote connection's askpass endpoint, token and passphrase cache.
pub struct Broker {
    endpoint: PathBuf,
    /// Session-scoped entropy source: used to name the private endpoint
    /// directory (Unix) and the pipe (Windows). It is *not* accepted as a
    /// wire token; the broker accepts only per-connection tickets from helpers
    /// (see `tickets`, `mint_ticket`, `take_ticket`).
    #[allow(dead_code)]
    token: Zeroizing<String>,
    helper_exe: PathBuf,
    provider: Provider,
    cache: Mutex<HashMap<String, CachedPass>>,
    /// Outstanding tickets minted by `ssh_env` (visible in the environment of
    /// exactly one ssh child), with (mint time, attempt count, allowed key
    /// paths). A ticket stays valid for the ssh child's lifetime with a small
    /// attempt cap, so a wrong-passphrase retry works. Expired entries and
    /// those over the cap are discarded. The allowed-key list binds the
    /// ticket to the destination's local identity files: a request whose
    /// prompt names a different key is declined, so a prompt from a jump
    /// host's ssh cannot get the passphrase of an unrelated key.
    tickets: Mutex<HashMap<String, Ticket>>,
    /// Number of SparkDown-started ssh calls running now. The broker refuses
    /// every helper request while this is zero. A counter lets overlapping
    /// calls open and close their windows independently.
    pending: std::sync::atomic::AtomicUsize,
    /// Held while the passphrase is looked up or asked for, so two
    /// connections never prompt at once.
    answering: Mutex<()>,
    /// Tests: make the peer check refuse every connection.
    #[cfg(test)]
    refuse_peers: std::sync::atomic::AtomicBool,
    /// The user dismissed the prompt during this connection.
    cancelled: std::sync::atomic::AtomicBool,
    /// A passphrase was handed to ssh during this connection.
    answered: std::sync::atomic::AtomicBool,
    /// A helper request with a valid token was refused (not a key prompt).
    refused: std::sync::atomic::AtomicBool,
    /// The key a refused passphrase prompt named (see `Outcome::refused_key`).
    refused_key: Mutex<Option<String>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(unix)]
    dir: PathBuf,
}

impl Broker {
    /// Open the endpoint and serve helper requests on a background thread.
    pub fn start(provider: Provider, helper_exe: PathBuf) -> std::io::Result<Arc<Broker>> {
        let token = Zeroizing::new(new_token());
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(unix)]
        let (endpoint, dir, listener) = {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("sparkdown-askpass-{}", &token[..16]));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir(&dir)?;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
            let path = dir.join("s");
            let listener = std::os::unix::net::UnixListener::bind(&path)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            (path, dir, listener)
        };
        #[cfg(windows)]
        let (endpoint, listener) = {
            let path = PathBuf::from(format!(
                r"\\.\pipe\sparkdown-askpass-{}",
                &new_token()[..32]
            ));
            let listener = crate::mcp::create_pipe_listener(&path)?;
            (path, listener)
        };
        let broker = Arc::new(Broker {
            endpoint,
            token,
            helper_exe,
            provider,
            cache: Mutex::new(HashMap::new()),
            tickets: Mutex::new(HashMap::new()),
            pending: std::sync::atomic::AtomicUsize::new(0),
            answering: Mutex::new(()),
            #[cfg(test)]
            refuse_peers: std::sync::atomic::AtomicBool::new(false),
            cancelled: std::sync::atomic::AtomicBool::new(false),
            answered: std::sync::atomic::AtomicBool::new(false),
            refused: std::sync::atomic::AtomicBool::new(false),
            refused_key: Mutex::new(None),
            stop: stop.clone(),
            #[cfg(unix)]
            dir,
        });
        let weak = Arc::downgrade(&broker);
        std::thread::Builder::new()
            .name("sparkdown-askpass".into())
            .spawn(move || {
                #[cfg(windows)]
                use interprocess::local_socket::traits::ListenerExt as _;
                for stream in listener.incoming() {
                    if stop.load(std::sync::atomic::Ordering::SeqCst) {
                        break;
                    }
                    let Ok(mut stream) = stream else { continue };
                    if weak.strong_count() == 0 {
                        break;
                    }
                    // Each connection on its own thread, so one that stops
                    // talking does not hold up the next request.
                    let weak = weak.clone();
                    let _ = std::thread::Builder::new()
                        .name("sparkdown-askpass-conn".into())
                        .spawn(move || {
                            // Peer verification before anything else: the
                            // socket perms already restrict callers to the
                            // same uid, and the kernel-signed check verifies
                            // that the peer uid matches the running app.
                            let Some(b) = weak.upgrade() else { return };
                            if !verify_peer(&stream, &b) {
                                let _ = stream.write_all(b"NO\n");
                                let _ = stream.flush();
                                return;
                            }
                            drop(b);
                            // A peer that stops talking is dropped after
                            // SERVE_TIMEOUT.
                            #[cfg(unix)]
                            {
                                let _ = stream.set_read_timeout(Some(SERVE_TIMEOUT));
                                let _ = stream.set_write_timeout(Some(SERVE_TIMEOUT));
                            }
                            serve_request(&mut stream, &weak);
                        });
                }
            })?;
        Ok(broker)
    }

    /// Environment for an ssh child that may need the key passphrase.
    ///
    /// Mints a fresh ticket for this ssh invocation and stores it in the
    /// broker's accept-set. The ticket is valid for one session with a
    /// small attempt cap, and is bound to `allowed_keys` — the local
    /// identity files ssh would try for this destination (the list the app
    /// builds with `identity_files_for_dest`). A request whose prompt names
    /// any other path is declined: an ssh started by ProxyJump/ProxyCommand
    /// inherits the ticket but not SparkDown's `-o` options, and its prompt
    /// text can come from a server.
    pub fn ssh_env(
        &self,
        allowed_keys: &[PathBuf],
    ) -> Vec<(&'static str, std::ffi::OsString)> {
        let ticket = self.mint_ticket(allowed_keys);
        let mut env = vec![
            ("SSH_ASKPASS", self.helper_exe.clone().into_os_string()),
            ("SSH_ASKPASS_REQUIRE", "force".into()),
            (ENV_IPC, self.endpoint.clone().into_os_string()),
            (ENV_TOKEN, ticket.into()),
        ];
        // OpenSSH before 8.4 ignores SSH_ASKPASS_REQUIRE and only uses the
        // askpass program when DISPLAY is set (any value; it is not opened).
        // A Wayland-only session may have none, so give the ssh child a
        // placeholder. An existing DISPLAY is left alone.
        #[cfg(unix)]
        if std::env::var_os("DISPLAY").is_none() {
            env.push(("DISPLAY", "sparkdown-askpass:0".into()));
        }
        env
    }

    /// Mint a fresh ticket and record it in the accept-set with zero
    /// attempts and the list of key paths this ssh child is allowed to ask
    /// for (the destination's local identity files, canonicalised).
    ///
    /// Also GCs expired entries and enforces `MAX_TICKETS` by dropping the
    /// oldest.
    fn mint_ticket(&self, allowed_keys: &[PathBuf]) -> String {
        // Canonicalise once at mint time so later comparisons are cheap and
        // `..`, extra slashes or a symlink name the same file. Paths that do not exist locally are
        // dropped: an identity file that is not on this machine cannot be
        // the subject of a legitimate key-unlock request.
        let allowed: Vec<PathBuf> = allowed_keys
            .iter()
            .filter_map(|p| canonical_key(p))
            .collect();
        let fresh = new_token();
        if let Ok(mut g) = self.tickets.lock() {
            let now = Instant::now();
            g.retain(|_, t| now.duration_since(t.issued) < TICKET_TTL);
            while g.len() >= MAX_TICKETS {
                // Drop the oldest entry; HashMap has no ordering so pick
                // the min by mint time explicitly.
                let oldest = g
                    .iter()
                    .min_by_key(|(_, t)| t.issued)
                    .map(|(k, _)| k.clone());
                match oldest {
                    Some(k) => {
                        g.remove(&k);
                    }
                    None => break,
                }
            }
            g.insert(
                fresh.clone(),
                Ticket {
                    issued: now,
                    attempts: 0,
                    allowed_keys: allowed,
                },
            );
        }
        fresh
    }

    /// Check and increment the attempt count for `got` if it is a known,
    /// unexpired ticket under the attempt cap, and return the allowed-key
    /// list bound to it.
    ///
    /// Comparison is constant-time against each candidate (the live set is
    /// at most `MAX_TICKETS`, with ~typical size 1–2). Returns the allowed
    /// keys and increments the attempt count on match; removes the ticket
    /// when the cap is reached. A given ssh child's ticket stays valid for
    /// retry (OpenSSH invokes the helper again after a wrong passphrase).
    fn take_ticket(&self, got: &str) -> Option<Vec<PathBuf>> {
        let mut g = self.tickets.lock().ok()?;
        let now = Instant::now();
        // Expire first so a stale match cannot succeed.
        g.retain(|_, t| now.duration_since(t.issued) < TICKET_TTL);
        let hit = g
            .keys()
            .find(|k| tokens_match(k.as_bytes(), got.as_bytes()))
            .cloned()?;
        let entry = g.get_mut(&hit)?;
        entry.attempts += 1;
        let allowed = entry.allowed_keys.clone();
        if entry.attempts >= MAX_TICKET_ATTEMPTS {
            g.remove(&hit);
        }
        Some(allowed)
    }

    /// Open a window in which the broker answers helper requests: hold the
    /// returned guard for as long as the ssh call that carries a ticket from
    /// [`Broker::ssh_env`] runs. Dropping the last guard closes the window and
    /// drops every outstanding ticket.
    pub fn pending_guard(self: &Arc<Self>) -> PendingGuard {
        self.pending
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        PendingGuard(self.clone())
    }

    fn is_pending(&self) -> bool {
        self.pending.load(std::sync::atomic::Ordering::SeqCst) > 0
    }

    fn close_pending(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        let mut prev = self.pending.load(SeqCst);
        while prev > 0 {
            match self
                .pending
                .compare_exchange_weak(prev, prev - 1, SeqCst, SeqCst)
            {
                Ok(_) => break,
                Err(now) => prev = now,
            }
        }
        if prev <= 1 {
            if let Ok(mut g) = self.tickets.lock() {
                g.clear();
            }
        }
    }

    /// Whether the user cancelled a prompt since the last call.
    pub fn take_cancelled(&self) -> bool {
        self.cancelled
            .swap(false, std::sync::atomic::Ordering::SeqCst)
    }

    /// Whether a passphrase was handed to ssh since the last call.
    pub fn take_answered(&self) -> bool {
        self.answered
            .swap(false, std::sync::atomic::Ordering::SeqCst)
    }

    /// Whether ssh's askpass request was refused since the last call.
    pub fn take_refused(&self) -> bool {
        self.refused
            .swap(false, std::sync::atomic::Ordering::SeqCst)
    }

    /// Everything a failed connect needs to word its error (#50); resets.
    pub fn take_outcome(&self) -> Outcome {
        Outcome {
            ready: true,
            cancelled: self.take_cancelled(),
            answered: self.take_answered(),
            refused: self.take_refused(),
            refused_key: self
                .refused_key
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take(),
        }
    }

    /// A passphrase prompt named `key`, which this ssh call may not ask for.
    /// Remembered for the connect error; the text is shown to the user, so
    /// control characters are dropped and the length capped.
    fn note_refused_key(&self, key: &str) {
        self.refused
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let shown: String = key.chars().filter(|c| !c.is_control()).take(200).collect();
        *self.refused_key.lock().unwrap_or_else(|e| e.into_inner()) = Some(shown);
    }

    fn passphrase_for(&self, key: &str) -> Option<Zeroizing<String>> {
        let got = self.lookup(key);
        if got.is_some() {
            self.answered
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        got
    }

    fn lookup(&self, key: &str) -> Option<Zeroizing<String>> {
        let mut retry = false;
        if let Ok(mut cache) = self.cache.lock() {
            if let Some((pass, answered)) = cache.get_mut(key) {
                retry = answered.is_some_and(|t| t.elapsed() < RETRY_WINDOW);
                if !retry {
                    *answered = Some(Instant::now());
                    return Some(Zeroizing::new(pass.as_str().to_string()));
                }
                // ssh asked again right away: the cached one was wrong.
                cache.remove(key);
            }
        }
        let got = (self.provider)(key, retry);
        match got {
            Some(pass) => {
                if let Ok(mut cache) = self.cache.lock() {
                    cache.insert(
                        key.to_string(),
                        (
                            Zeroizing::new(pass.as_str().to_string()),
                            Some(Instant::now()),
                        ),
                    );
                }
                Some(pass)
            }
            None => {
                self.cancelled
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                None
            }
        }
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        // Wake the accept loop so the thread sees `stop` and exits.
        #[cfg(unix)]
        {
            let _ = std::os::unix::net::UnixStream::connect(&self.endpoint);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
        #[cfg(windows)]
        {
            use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
            if let Ok(name) = self.endpoint.as_os_str().to_fs_name::<GenericFilePath>() {
                let _ = Stream::connect(name);
            }
        }
        // `cache` and `token` are Zeroizing: wiped as they drop.
    }
}

// --- Session broker + UI provider -------------------------------------------------

/// The askpass broker of each window's SSH session (#60 decision 6: one
/// session per window), keyed by window label.
fn session_brokers() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Broker>>> {
    static B: std::sync::OnceLock<Mutex<HashMap<String, Arc<Broker>>>> = std::sync::OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The broker the current window's ssh calls use, if its connect set one up.
pub fn current() -> Option<Arc<Broker>> {
    session_brokers()
        .get(&crate::windows::current_label())
        .cloned()
}

/// Replace the current window's broker (None = tear down: endpoint closed,
/// cache wiped).
pub fn set_current(b: Option<Arc<Broker>>) {
    let label = crate::windows::current_label();
    let old = {
        let mut g = session_brokers();
        match b {
            Some(b) => g.insert(label, b),
            None => g.remove(&label),
        }
    };
    // Dropped outside the lock (Drop wakes and joins the endpoint).
    drop(old);
}

/// Pending UI prompts: request id → (asking window, where the answer goes).
type Pending = HashMap<u64, (String, std::sync::mpsc::Sender<Option<Zeroizing<String>>>)>;

fn pending() -> &'static Mutex<Pending> {
    static P: std::sync::OnceLock<Mutex<Pending>> = std::sync::OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What the passphrase dialog shows.
#[derive(serde::Serialize, Clone)]
pub struct AskpassRequest {
    pub id: u64,
    /// The key path from ssh's prompt, `~` for the home dir.
    pub key: String,
    /// ssh asked again: the passphrase just given was wrong.
    pub retry: bool,
}

/// How long the dialog may stay open before the request is refused.
const UI_TIMEOUT: Duration = Duration::from_secs(300);

/// Provider that asks the user in the masked passphrase dialog of the
/// connecting window only (`label`, #60 decision 6).
pub fn ui_provider(app: tauri::AppHandle, label: String) -> Provider {
    use tauri::Emitter;
    Arc::new(move |key: &str, retry: bool| {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = std::sync::mpsc::channel();
        pending().lock().ok()?.insert(id, (label.clone(), tx));
        let shown = crate::remote::display_home_path(key);
        if app
            .emit_to(
                label.as_str(),
                "askpass://request",
                AskpassRequest {
                    id,
                    key: shown,
                    retry,
                },
            )
            .is_err()
        {
            pending().lock().ok()?.remove(&id);
            return None;
        }
        let answer = rx.recv_timeout(UI_TIMEOUT).ok().flatten();
        if let Ok(mut p) = pending().lock() {
            p.remove(&id);
        }
        answer
    })
}

/// The dialog's answer: the passphrase, or None for Cancel. The string is
/// moved into a wiping buffer at once; serde's own copy of the IPC message
/// is outside our control (documented in docs/remote-ssh.md).
#[tauri::command]
pub fn askpass_answer(webview_window: tauri::WebviewWindow, id: u64, passphrase: Option<String>) {
    answer_from(webview_window.label(), id, passphrase.map(Zeroizing::new));
}

/// Deliver an answer, but only from the window that was asked.
/// Drop a closed window's broker and cancel any prompt it still had open.
pub fn release_window(label: &str) {
    let old = session_brokers().remove(label);
    drop(old);
    let stale: Vec<u64> = pending()
        .lock()
        .map(|p| {
            p.iter()
                .filter(|(_, (l, _))| l == label)
                .map(|(id, _)| *id)
                .collect()
        })
        .unwrap_or_default();
    for id in stale {
        answer_from(label, id, None);
    }
}

fn answer_from(label: &str, id: u64, answer: Option<Zeroizing<String>>) {
    let tx = pending().lock().ok().and_then(|mut p| {
        if p.get(&id).is_some_and(|(asked, _)| asked == label) {
            p.remove(&id).map(|(_, tx)| tx)
        } else {
            None
        }
    });
    if let Some(tx) = tx {
        let _ = tx.send(answer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_asking_window_can_answer() {
        let (tx, rx) = std::sync::mpsc::channel();
        pending()
            .lock()
            .unwrap()
            .insert(9_000_001, ("w-a".into(), tx));
        answer_from("w-b", 9_000_001, Some(Zeroizing::new("x".into())));
        assert!(rx.try_recv().is_err(), "another window's answer is ignored");
        answer_from("w-a", 9_000_001, Some(Zeroizing::new("pw".into())));
        assert_eq!(rx.try_recv().unwrap().unwrap().as_str(), "pw");
    }

    #[test]
    fn brokers_are_per_window() {
        let provider: Provider = Arc::new(|_k: &str, _r: bool| None);
        let b = Broker::start(provider, PathBuf::from("/nonexistent-helper")).unwrap();
        {
            let _s = crate::windows::enter("w-broker-a");
            set_current(Some(b));
            assert!(current().is_some());
        }
        {
            let _s = crate::windows::enter("w-broker-b");
            assert!(current().is_none(), "window b has no session");
        }
        let _s = crate::windows::enter("w-broker-a");
        set_current(None);
        assert!(current().is_none());
    }

    #[test]
    fn classifier_accepts_only_key_passphrase_prompts() {
        assert_eq!(
            classify_prompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': ").as_deref(),
            Some("/home/u/.ssh/id_ed25519")
        );
        assert_eq!(
            classify_prompt("Enter passphrase for key 'C:\\Users\\u\\.ssh\\id_ed25519':")
                .as_deref(),
            Some("C:\\Users\\u\\.ssh\\id_ed25519")
        );
        assert_eq!(
            classify_prompt("Enter passphrase for /home/u/.ssh/id_rsa: ").as_deref(),
            Some("/home/u/.ssh/id_rsa")
        );
        assert_eq!(
            classify_prompt("Bad passphrase, try again for /home/u/.ssh/id_rsa: ").as_deref(),
            Some("/home/u/.ssh/id_rsa")
        );
        for refused in [
            "me@host's password: ",
            "Password: ",
            "password for me@host: ",
            "(me@host) Password: ",
            "Enter passphrase for key with password: ",
            "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
            "Enter PIN for ED25519-SK key /home/u/.ssh/id_ed25519_sk: ",
            "Confirm user presence for key ED25519-SK SHA256:abc",
            "Verification code: ",
            "Enter passphrase for key '/a':\nPassword: ",
            "Enter passphrase for key '': ",
            "Enter passphrase (empty for no passphrase): ",
            "",
            "Allow use of key /home/u/.ssh/id? Key fingerprint SHA256:x.",
        ] {
            assert_eq!(classify_prompt(refused), None, "{refused:?}");
        }
    }

    #[test]
    fn token_check_is_exact() {
        assert!(tokens_match(b"abc123", b"abc123"));
        assert!(!tokens_match(b"abc123", b"abc124"));
        assert!(!tokens_match(b"abc123", b"abc12"));
        assert!(!tokens_match(b"abc123", b"abc1234"));
        assert!(!tokens_match(b"", b""));
        let t = new_token();
        assert_eq!(t.len(), 64);
        assert_ne!(t, new_token());
    }

    fn test_broker(answer: Option<&'static str>) -> (Arc<Broker>, Arc<Mutex<Vec<String>>>) {
        let (b, asked) = test_broker_closed(answer);
        // These tests drive the broker directly, so keep its window open.
        let _keep_open = std::mem::ManuallyDrop::new(b.pending_guard());
        (b, asked)
    }

    /// A broker with no ssh call running: it refuses every request.
    fn test_broker_closed(answer: Option<&'static str>) -> (Arc<Broker>, Arc<Mutex<Vec<String>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let log = asked.clone();
        let provider: Provider = Arc::new(move |key: &str, retry: bool| {
            log.lock()
                .unwrap()
                .push(format!("{key}{}", if retry { " (retry)" } else { "" }));
            answer.map(|a| Zeroizing::new(a.to_string()))
        });
        (
            Broker::start(provider, PathBuf::from("/nonexistent-helper")).unwrap(),
            asked,
        )
    }

    #[cfg(unix)]
    fn connect(b: &Broker) -> std::os::unix::net::UnixStream {
        std::os::unix::net::UnixStream::connect(&b.endpoint).unwrap()
    }

    /// A real file on disk the broker can canonicalise as an allowed key,
    /// and the OpenSSH-style prompt that names it. Tests must keep the
    /// returned `TempDir` alive for as long as the file must exist.
    #[cfg(unix)]
    fn test_key() -> (tempfile::TempDir, PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("id");
        std::fs::write(&key, b"not-a-real-key").unwrap();
        let canon = std::fs::canonicalize(&key).unwrap();
        let prompt = format!("Enter passphrase for key '{}': ", canon.display());
        (dir, canon, prompt)
    }

    /// Mint a ticket bound to a single on-disk identity file.
    #[cfg(unix)]
    fn mint_for(b: &Broker, key: &Path) -> String {
        b.mint_ticket(&[key.to_path_buf()])
    }

    #[cfg(unix)]
    #[test]
    fn broker_answers_with_the_right_token_only() {
        let (b, asked) = test_broker(Some("s3cret pass"));
        let (_tmp, key, prompt) = test_key();
        let got = request(&mut connect(&b), &mint_for(&b, &key), &prompt).unwrap();
        assert_eq!(&got[..], b"s3cret pass");
        assert_eq!(*asked.lock().unwrap(), vec![key.display().to_string()]);
        // Wrong token: refused, and the user is not asked.
        let bad = "0".repeat(64);
        assert!(request(&mut connect(&b), &bad, &prompt).is_none());
        assert!(request(&mut connect(&b), "", &prompt).is_none());
        // The static session token (used only to name the private endpoint
        // dir) must not itself be accepted as a wire token.
        assert!(request(&mut connect(&b), &b.token, &prompt).is_none());
        assert_eq!(asked.lock().unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn broker_refuses_non_passphrase_prompts_even_from_a_valid_helper() {
        let (b, asked) = test_broker(Some("pw"));
        let (_tmp, key, _) = test_key();
        for prompt in [
            "me@host's password: ",
            "Are you sure you want to continue connecting (yes/no)? ",
        ] {
            assert!(
                request(&mut connect(&b), &mint_for(&b, &key), prompt).is_none(),
                "{prompt}"
            );
        }
        assert!(asked.lock().unwrap().is_empty());
        // #50: the refusal is recorded for the connect error, once.
        let o = b.take_outcome();
        assert!(o.ready && o.refused && !o.answered && !o.cancelled, "{o:?}");
        assert!(!b.take_outcome().refused);
    }

    #[cfg(unix)]
    #[test]
    fn broker_refuses_a_key_path_not_in_the_ticket_allowlist() {
        // A key-passphrase prompt can name any path (the text may come from
        // a jump host's server). The broker must refuse a path
        // outside the ticket's allowed identity files, even with a valid
        // ticket and inside a pending window.
        let (b, asked) = test_broker(Some("pw"));
        let (_tmp_allowed, allowed_key, _) = test_key();
        let (_tmp_other, _other_key, other_prompt) = test_key();
        let ticket = mint_for(&b, &allowed_key);
        assert!(
            request(&mut connect(&b), &ticket, &other_prompt).is_none(),
            "a request for a key the ticket is not bound to must be refused"
        );
        assert!(
            asked.lock().unwrap().is_empty(),
            "the user is never asked for an un-allowlisted key"
        );
        // Refusal is recorded so the connect error can mention it.
        let o = b.take_outcome();
        assert!(o.refused, "{o:?}");
        assert_eq!(
            o.refused_key.as_deref(),
            Some(_other_key.display().to_string().as_str())
        );
        assert!(b.take_outcome().refused_key.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn broker_refuses_a_path_that_does_not_exist_locally() {
        // A ticket can only bind to files that are on this machine. A
        // prompt that names a path which does not exist cannot name a
        // legitimate local key, so it is refused.
        let (b, _) = test_broker(Some("pw"));
        let (_tmp, key, _) = test_key();
        let ticket = mint_for(&b, &key);
        let nowhere = "Enter passphrase for key '/does-not-exist-on-this-host/id': ";
        assert!(
            request(&mut connect(&b), &ticket, nowhere).is_none(),
            "a request whose named path does not exist must be refused"
        );
    }

    #[cfg(unix)]
    #[test]
    fn broker_caches_for_the_session_but_re_asks_after_a_wrong_passphrase() {
        let (b, asked) = test_broker(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        let key_str = key.display().to_string();
        request(&mut connect(&b), &mint_for(&b, &key), &prompt).unwrap();
        // An immediate repeat is ssh retrying: ask the user again.
        request(&mut connect(&b), &mint_for(&b, &key), &prompt).unwrap();
        // #52: the second prompt is flagged so the dialog says "incorrect".
        assert_eq!(
            *asked.lock().unwrap(),
            vec![key_str.clone(), format!("{key_str} (retry)")]
        );
        // Later (a reconnect), the cached passphrase answers silently.
        if let Ok(mut c) = b.cache.lock() {
            c.get_mut(&key_str).unwrap().1 = None;
        }
        request(&mut connect(&b), &mint_for(&b, &key), &prompt).unwrap();
        assert_eq!(asked.lock().unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn cancel_is_reported_and_endpoint_is_private() {
        use std::os::unix::fs::PermissionsExt;
        // Not `test_broker`: its guard is never dropped, so the broker
        // would never be dropped either.
        let (b, _) = test_broker_closed(None);
        let open = b.pending_guard();
        let (_tmp, key, prompt) = test_key();
        let dir_mode = std::fs::metadata(&b.dir).unwrap().permissions().mode();
        let sock_mode = std::fs::metadata(&b.endpoint).unwrap().permissions().mode();
        assert_eq!(dir_mode & 0o777, 0o700);
        assert_eq!(sock_mode & 0o777, 0o600);
        assert!(request(&mut connect(&b), &mint_for(&b, &key), &prompt).is_none());
        assert!(b.take_cancelled());
        assert!(!b.take_cancelled());
        let dir = b.dir.clone();
        drop(open);
        drop(b);
        // The serving thread may hold the last reference for a moment after
        // replying; the endpoint goes when that one drops.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while dir.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!dir.exists(), "endpoint dir removed on drop");
    }

    #[test]
    fn ssh_env_mints_a_fresh_per_connection_ticket() {
        let (b, _) = test_broker(Some("never-in-env"));
        let env1 = b.ssh_env(&[]);
        let env2 = b.ssh_env(&[]);
        // Each spawn gets a distinct ticket.
        let n1 = env1
            .iter()
            .find(|(k, _)| *k == ENV_TOKEN)
            .map(|(_, v)| v.clone())
            .unwrap();
        let n2 = env2
            .iter()
            .find(|(k, _)| *k == ENV_TOKEN)
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_ne!(n1, n2, "ssh_env must mint a fresh ticket per spawn");
        // And neither is the static session token (which only names the
        // private endpoint dir and is never a valid wire credential).
        let session_token: std::ffi::OsString = b.token.as_str().into();
        assert_ne!(n1, session_token);
        assert_ne!(n2, session_token);
    }

    #[test]
    fn ssh_env_carries_no_passphrase() {
        let (b, _) = test_broker(Some("never-in-env"));
        let env = b.ssh_env(&[]);
        let keys: Vec<_> = env.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            keys[..4],
            ["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", ENV_IPC, ENV_TOKEN]
        );
        // At most the DISPLAY placeholder for pre-8.4 ssh follows.
        assert!(keys[4..].iter().all(|k| *k == "DISPLAY"));
        assert!(env
            .iter()
            .all(|(_, v)| !v.to_string_lossy().contains("never-in-env")));
        assert_eq!(env[1].1, "force");
    }

    #[cfg(unix)]
    #[test]
    fn ticket_stays_valid_for_wrong_passphrase_retry() {
        // A given ssh child keeps one ticket in its environment. OpenSSH
        // invokes the askpass helper again in the same process after a wrong
        // passphrase; the second request must succeed with the same ticket.
        let (b, _) = test_broker(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        let ticket = mint_for(&b, &key);
        // First request succeeds.
        request(&mut connect(&b), &ticket, &prompt).unwrap();
        // Second request with the same ticket also succeeds (retry).
        request(&mut connect(&b), &ticket, &prompt).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ticket_is_refused_after_attempt_cap() {
        // A ticket is accepted at most MAX_TICKET_ATTEMPTS times.
        let (b, _) = test_broker(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        let ticket = mint_for(&b, &key);
        // Use up the cap.
        for _ in 0..MAX_TICKET_ATTEMPTS {
            assert!(
                request(&mut connect(&b), &ticket, &prompt).is_some(),
                "within cap"
            );
        }
        // The next attempt is refused.
        assert!(
            request(&mut connect(&b), &ticket, &prompt).is_none(),
            "over cap"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_expired_ticket_is_refused() {
        let (b, _) = test_broker(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        let ticket = mint_for(&b, &key);
        let Some(old) = Instant::now().checked_sub(TICKET_TTL + Duration::from_secs(1)) else {
            return;
        };
        {
            let mut g = b.tickets.lock().unwrap();
            let entry = g.get_mut(&ticket).unwrap();
            entry.issued = old;
        }
        assert!(
            request(&mut connect(&b), &ticket, &prompt).is_none(),
            "a ticket older than the lifetime must be refused"
        );
        assert!(b.tickets.lock().unwrap().get(&ticket).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn minting_past_the_cap_drops_the_oldest_ticket() {
        let (b, _) = test_broker(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        let first = mint_for(&b, &key);
        if let Some(t) = Instant::now().checked_sub(Duration::from_secs(10)) {
            let mut g = b.tickets.lock().unwrap();
            if let Some(entry) = g.get_mut(&first) {
                entry.issued = t;
            }
        }
        let mut last = String::new();
        for _ in 0..MAX_TICKETS {
            last = mint_for(&b, &key);
        }
        assert!(b.tickets.lock().unwrap().len() <= MAX_TICKETS);
        assert!(
            request(&mut connect(&b), &first, &prompt).is_none(),
            "the oldest ticket is dropped once the cap is reached"
        );
        assert!(request(&mut connect(&b), &last, &prompt).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn same_user_accepts_only_our_own_uid() {
        assert!(same_user(Some(1000), 1000));
        assert!(!same_user(Some(1001), 1000));
        assert!(!same_user(Some(0), 1000));
        assert!(!same_user(None, 1000), "a failed lookup must refuse");
    }

    #[cfg(unix)]
    #[test]
    fn verify_peer_accepts_a_same_user_socket_pair() {
        let (b, _) = test_broker(Some("pw"));
        let (client, server) = std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&server), Some(current_uid()));
        assert!(verify_peer(&server, &b));
        drop(client);
    }

    #[cfg(unix)]
    #[test]
    fn listener_answers_no_when_the_peer_check_refuses() {
        let (b, _) = test_broker(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        let ticket = mint_for(&b, &key);
        assert!(request(&mut connect(&b), &ticket, &prompt).is_some());
        b.refuse_peers
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(
            request(&mut connect(&b), &ticket, &prompt).is_none(),
            "a refused peer must not get an answer even with a valid ticket"
        );
    }

    #[cfg(unix)]
    #[test]
    fn requests_are_refused_unless_an_ssh_call_is_running() {
        let (b, asked) = test_broker_closed(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        let ticket = mint_for(&b, &key);
        assert!(
            request(&mut connect(&b), &ticket, &prompt).is_none(),
            "no ssh call is running"
        );
        assert!(asked.lock().unwrap().is_empty(), "the user is not asked");
        let guard = b.pending_guard();
        let ticket = mint_for(&b, &key);
        assert!(request(&mut connect(&b), &ticket, &prompt).is_some());
        drop(guard);
        let ticket = mint_for(&b, &key);
        assert!(
            request(&mut connect(&b), &ticket, &prompt).is_none(),
            "the window closed with the call"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_last_ssh_call_to_end_drops_every_ticket() {
        let (b, _) = test_broker_closed(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        let first = b.pending_guard();
        let second = b.pending_guard();
        let ticket = mint_for(&b, &key);
        drop(first);
        // One call is still running: its ticket still works.
        assert!(request(&mut connect(&b), &ticket, &prompt).is_some());
        drop(second);
        // Re-open a window: the ticket from before is gone.
        let _again = b.pending_guard();
        assert!(
            request(&mut connect(&b), &ticket, &prompt).is_none(),
            "a ticket does not outlive the calls it was minted for"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_peer_that_stops_talking_does_not_block_the_next_request() {
        let (b, _) = test_broker(Some("pw"));
        let (_tmp, key, prompt) = test_key();
        // Connects, sends half a header, then goes quiet.
        let mut idle = connect(&b);
        idle.write_all(b"SDASK1 ").unwrap();
        let start = Instant::now();
        let got = request(&mut connect(&b), &mint_for(&b, &key), &prompt);
        assert!(got.is_some(), "the next request is served");
        assert!(
            start.elapsed() < SERVE_TIMEOUT / 2,
            "served while the quiet peer is still connected"
        );
        drop(idle);
    }

    #[cfg(unix)]
    #[test]
    fn a_quiet_peer_does_not_keep_a_dropped_broker() {
        let (b, _) = test_broker_closed(Some("pw"));
        let mut idle = connect(&b);
        idle.write_all(b"SDASK1 ").unwrap();
        // Let the connection thread start reading.
        std::thread::sleep(Duration::from_millis(100));
        let dir = b.dir.clone();
        let start = Instant::now();
        drop(b);
        while dir.exists() && start.elapsed() < SERVE_TIMEOUT {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !dir.exists(),
            "endpoint removed while the peer is still connected"
        );
        assert!(start.elapsed() < SERVE_TIMEOUT / 2);
        drop(idle);
    }

    // Guards IPC/TOKEN env vars so other tests are unaffected.
    struct HelperEnvGuard {
        ipc: Option<std::ffi::OsString>,
        token: Option<std::ffi::OsString>,
    }
    impl HelperEnvGuard {
        fn new() -> Self {
            Self {
                ipc: std::env::var_os(ENV_IPC),
                token: std::env::var_os(ENV_TOKEN),
            }
        }
    }
    impl Drop for HelperEnvGuard {
        fn drop(&mut self) {
            match self.ipc.take() {
                Some(v) => std::env::set_var(ENV_IPC, v),
                None => std::env::remove_var(ENV_IPC),
            }
            match self.token.take() {
                Some(v) => std::env::set_var(ENV_TOKEN, v),
                None => std::env::remove_var(ENV_TOKEN),
            }
        }
    }

    #[test]
    #[serial_test::serial(sparkdown_askpass_env)]
    fn helper_mode_is_entered_for_prompt_starting_with_dashes() {
        // A server-side keyboard-interactive prompt such as `--mcp-stdio` /
        // `--new-window` / `--version` reaches the binary as argv[1]. With
        // the askpass env set, main() must still go to helper_main, which
        // declines the non-passphrase prompt (exit 1), instead of the CLI /
        // MCP shim / single-instance code.
        let _g = HelperEnvGuard::new();
        std::env::set_var(ENV_IPC, "/tmp/sparkdown-askpass-test.sock");
        std::env::set_var(ENV_TOKEN, "deadbeef");
        assert!(is_helper_invocation(), "both env vars present => helper mode");
        // The prompts themselves are what classify_prompt refuses; verify.
        assert_eq!(classify_prompt("--mcp-stdio"), None);
        assert_eq!(classify_prompt("--new-window"), None);
        assert_eq!(classify_prompt("--version"), None);
    }

    #[test]
    #[serial_test::serial(sparkdown_askpass_env)]
    fn helper_mode_passes_valid_passphrase_prompt_through() {
        // Valid case: a real ssh key-passphrase prompt still enters helper
        // mode and is accepted by classify_prompt (so helper_main proceeds
        // to answer over the private IPC as before).
        let _g = HelperEnvGuard::new();
        std::env::set_var(ENV_IPC, "/tmp/sparkdown-askpass-test.sock");
        std::env::set_var(ENV_TOKEN, "deadbeef");
        assert!(is_helper_invocation());
        assert_eq!(
            classify_prompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': ")
                .as_deref(),
            Some("/home/u/.ssh/id_ed25519"),
        );
    }

    #[test]
    #[serial_test::serial(sparkdown_askpass_env)]
    fn helper_mode_is_not_entered_without_the_askpass_env() {
        // Compatibility: a normal CLI invocation (no askpass env) is not
        // treated as a helper invocation, so `--version` / `--help` / the
        // GUI startup paths are unaffected.
        let _g = HelperEnvGuard::new();
        std::env::remove_var(ENV_IPC);
        std::env::remove_var(ENV_TOKEN);
        assert!(!is_helper_invocation());
        std::env::set_var(ENV_IPC, "/tmp/x");
        std::env::remove_var(ENV_TOKEN);
        assert!(!is_helper_invocation(), "ipc alone is not enough");
        std::env::remove_var(ENV_IPC);
        std::env::set_var(ENV_TOKEN, "tok");
        assert!(!is_helper_invocation(), "token alone is not enough");
    }
}
