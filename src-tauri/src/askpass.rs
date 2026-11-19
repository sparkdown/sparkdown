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
//! The helper presents a random nonce passed in its environment
//! (`SPARKDOWN_ASKPASS_TOKEN`): the broker mints a fresh nonce for every ssh
//! child it spawns and tracks attempt counts per nonce. A given nonce stays
//! valid for the ssh child's lifetime with a small attempt cap, so a
//! wrong-passphrase retry works. On Unix the broker also verifies the peer
//! uid matches the running app.
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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

/// Env var naming the broker's IPC endpoint (also the askpass-mode switch).
pub const ENV_IPC: &str = "SPARKDOWN_ASKPASS_IPC";
/// Env var carrying the helper's per-connection nonce (fresh per ssh spawn,
/// valid for the ssh session with a small attempt cap).
pub const ENV_TOKEN: &str = "SPARKDOWN_ASKPASS_TOKEN";

/// Protocol tag; bump on any wire change.
const MAGIC: &str = "SDASK1";
/// Longest prompt or passphrase accepted on the wire.
const MAX_LEN: usize = 4096;
/// A repeat ask for the same key this soon after an answer is ssh retrying a
/// wrong passphrase: drop the cached one and ask the user again.
const RETRY_WINDOW: Duration = Duration::from_secs(15);
/// A minted nonce is accepted at most this long after it was handed to an
/// ssh child. Matches the helper's IPC read timeout: if ssh hasn't invoked
/// the askpass helper within this window, it never will.
const NONCE_TTL: Duration = Duration::from_secs(300);
/// A hard cap on outstanding (unconsumed, unexpired) nonces.
const MAX_NONCES: usize = 32;
/// A given nonce is accepted at most this many times. Allows a
/// wrong-passphrase retry (OpenSSH invokes the askpass helper again in the
/// same ssh process after a wrong answer).
const MAX_NONCE_ATTEMPTS: usize = 5;

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

/// 256 random bits as hex: /dev/urandom on Unix; on Windows the OS-seeded
/// `RandomState` construction the MCP pipe name uses.
pub fn new_token() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 32];
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            if f.read_exact(&mut buf).is_ok() {
                return buf.iter().map(|b| format!("{b:02x}")).collect();
            }
        }
        // No urandom: fall through to the hasher construction.
    }
    fallback_token()
}

fn fallback_token() -> String {
    #[cfg(windows)]
    {
        format!(
            "{}{}",
            crate::mcp::random_token(),
            crate::mcp::random_token()
        )
    }
    #[cfg(not(windows))]
    {
        use std::hash::{BuildHasher, Hasher};
        let mut t = String::new();
        for i in 0..4u64 {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(0x9E37_79B9_7F4A_7C15 ^ i);
            t.push_str(&format!("{:016x}", h.finish()));
        }
        t
    }
}

// --- Wire protocol ------------------------------------------------------------
//
// helper → app: "SDASK1 <token> <prompt_len>\n<prompt bytes>"
// app → helper: "OK <len>\n<passphrase bytes>"  or  "NO\n"

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
/// current user. The per-connection nonce is the primary check; this one
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
        // nonce as the authoritative check for now.
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
fn serve_request<S: Read + Write>(stream: &mut S, broker: &Broker) {
    let reply_no = |s: &mut S| {
        let _ = s.write_all(b"NO\n");
        let _ = s.flush();
    };
    let Some(head) = read_line_capped(stream, 256) else {
        return reply_no(stream);
    };
    let mut parts = head.split(' ');
    let (Some(MAGIC), Some(token), Some(len), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return reply_no(stream);
    };
    // A nonce is valid for one session. `take_nonce` validates the nonce
    // and enforces the attempt cap.
    if !broker.take_nonce(token) {
        return reply_no(stream);
    }
    let Some(len) = len.parse::<usize>().ok() else {
        return reply_no(stream);
    };
    let Some(prompt) = read_exact_vec(stream, len) else {
        return reply_no(stream);
    };
    let Ok(prompt) = std::str::from_utf8(&prompt) else {
        return reply_no(stream);
    };
    // Verify the prompt classification on the broker side.
    let Some(key) = classify_prompt(prompt) else {
        broker
            .refused
            .store(true, std::sync::atomic::Ordering::SeqCst);
        return reply_no(stream);
    };
    match broker.passphrase_for(&key) {
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
pub fn is_helper_invocation() -> bool {
    std::env::var_os(ENV_IPC).is_some()
        && std::env::var_os(ENV_TOKEN).is_some()
        && std::env::args()
            .nth(1)
            .is_some_and(|a| !a.starts_with("--"))
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

/// What happened with askpass during one connect attempt (#50).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// An askpass endpoint was up, so ssh could ask for a key passphrase.
    pub ready: bool,
    /// The user dismissed the passphrase prompt.
    pub cancelled: bool,
    /// A passphrase was handed to ssh.
    pub answered: bool,
    /// ssh's askpass request was refused (not a key passphrase prompt).
    pub refused: bool,
}

/// One remote connection's askpass endpoint, token and passphrase cache.
pub struct Broker {
    endpoint: PathBuf,
    /// Session-scoped entropy source: used to name the private endpoint
    /// directory (Unix) and the pipe (Windows). It is *not* accepted as a
    /// wire token; the broker accepts only per-connection nonces from helpers
    /// (see `nonces`, `mint_nonce`, `take_nonce`).
    #[allow(dead_code)]
    token: Zeroizing<String>,
    helper_exe: PathBuf,
    provider: Provider,
    cache: Mutex<HashMap<String, CachedPass>>,
    /// Outstanding nonces minted by `ssh_env` (visible in the environment of
    /// exactly one ssh child), with (mint time, attempt count). A nonce stays
    /// valid for the ssh child's lifetime with a small attempt cap, so a
    /// wrong-passphrase retry works. Expired entries and those over the cap
    /// are discarded.
    nonces: Mutex<HashMap<String, (Instant, usize)>>,
    /// Tests: make the peer check refuse every connection.
    #[cfg(test)]
    refuse_peers: std::sync::atomic::AtomicBool,
    /// The user dismissed the prompt during this connection.
    cancelled: std::sync::atomic::AtomicBool,
    /// A passphrase was handed to ssh during this connection.
    answered: std::sync::atomic::AtomicBool,
    /// A helper request with a valid token was refused (not a key prompt).
    refused: std::sync::atomic::AtomicBool,
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
            nonces: Mutex::new(HashMap::new()),
            #[cfg(test)]
            refuse_peers: std::sync::atomic::AtomicBool::new(false),
            cancelled: std::sync::atomic::AtomicBool::new(false),
            answered: std::sync::atomic::AtomicBool::new(false),
            refused: std::sync::atomic::AtomicBool::new(false),
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
                    let Some(b) = weak.upgrade() else { break };
                    // Peer verification before anything else: the socket
                    // perms already restrict callers to the same uid, and
                    // the kernel-signed check verifies that the peer uid
                    // matches the running app.
                    if !verify_peer(&stream, &b) {
                        let _ = stream.write_all(b"NO\n");
                        let _ = stream.flush();
                        continue;
                    }
                    // One request at a time: prompts are rare and sequential.
                    serve_request(&mut stream, &b);
                }
            })?;
        Ok(broker)
    }

    /// Environment for an ssh child that may need the key passphrase.
    ///
    /// Mints a fresh nonce for this ssh invocation and stores it in the
    /// broker's accept-set. The nonce is valid for one session with a
    /// small attempt cap.
    pub fn ssh_env(&self) -> Vec<(&'static str, std::ffi::OsString)> {
        let nonce = self.mint_nonce();
        let mut env = vec![
            ("SSH_ASKPASS", self.helper_exe.clone().into_os_string()),
            ("SSH_ASKPASS_REQUIRE", "force".into()),
            (ENV_IPC, self.endpoint.clone().into_os_string()),
            (ENV_TOKEN, nonce.into()),
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

    /// Mint a fresh nonce and record it in the accept-set with zero attempts.
    ///
    /// Also GCs expired entries and enforces `MAX_NONCES` by dropping the
    /// oldest.
    fn mint_nonce(&self) -> String {
        let fresh = new_token();
        if let Ok(mut g) = self.nonces.lock() {
            let now = Instant::now();
            g.retain(|_, (t, _)| now.duration_since(*t) < NONCE_TTL);
            while g.len() >= MAX_NONCES {
                // Drop the oldest entry; HashMap has no ordering so pick
                // the min by mint time explicitly.
                let oldest = g
                    .iter()
                    .min_by_key(|(_, (t, _))| *t)
                    .map(|(k, _)| k.clone());
                match oldest {
                    Some(k) => {
                        g.remove(&k);
                    }
                    None => break,
                }
            }
            g.insert(fresh.clone(), (now, 0));
        }
        fresh
    }

    /// Check and increment the attempt count for `got` if it is a known,
    /// unexpired nonce under the attempt cap.
    ///
    /// Comparison is constant-time against each candidate (the live set is
    /// at most `MAX_NONCES`, with ~typical size 1–2). Returns true and
    /// increments the attempt count on match; removes the nonce when the cap
    /// is reached. A given ssh child's nonce stays valid for retry (OpenSSH
    /// invokes the helper again after a wrong passphrase).
    fn take_nonce(&self, got: &str) -> bool {
        let Ok(mut g) = self.nonces.lock() else {
            return false;
        };
        let now = Instant::now();
        // Expire first so a stale match cannot succeed.
        g.retain(|_, (t, _)| now.duration_since(*t) < NONCE_TTL);
        let hit = g
            .keys()
            .find(|k| tokens_match(k.as_bytes(), got.as_bytes()))
            .cloned();
        if let Some(k) = hit {
            let (mint_time, attempts) = g.get(&k).copied().unwrap();
            let new_attempts = attempts + 1;
            if new_attempts >= MAX_NONCE_ATTEMPTS {
                g.remove(&k);
            } else {
                g.insert(k, (mint_time, new_attempts));
            }
            true
        } else {
            false
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
        }
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

    #[cfg(unix)]
    #[test]
    fn broker_answers_with_the_right_token_only() {
        let (b, asked) = test_broker(Some("s3cret pass"));
        let prompt = "Enter passphrase for key '/k/id': ";
        let got = request(&mut connect(&b), &b.mint_nonce(), prompt).unwrap();
        assert_eq!(&got[..], b"s3cret pass");
        assert_eq!(*asked.lock().unwrap(), vec!["/k/id".to_string()]);
        // Wrong token: refused, and the user is not asked.
        let bad = "0".repeat(64);
        assert!(request(&mut connect(&b), &bad, prompt).is_none());
        assert!(request(&mut connect(&b), "", prompt).is_none());
        // The static session token (used only to name the private endpoint
        // dir) must not itself be accepted as a wire token.
        assert!(request(&mut connect(&b), &b.token, prompt).is_none());
        assert_eq!(asked.lock().unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn broker_refuses_non_passphrase_prompts_even_from_a_valid_helper() {
        let (b, asked) = test_broker(Some("pw"));
        for prompt in [
            "me@host's password: ",
            "Are you sure you want to continue connecting (yes/no)? ",
        ] {
            assert!(
                request(&mut connect(&b), &b.mint_nonce(), prompt).is_none(),
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
    fn broker_caches_for_the_session_but_re_asks_after_a_wrong_passphrase() {
        let (b, asked) = test_broker(Some("pw"));
        let prompt = "Enter passphrase for key '/k/id': ";
        request(&mut connect(&b), &b.mint_nonce(), prompt).unwrap();
        // An immediate repeat is ssh retrying: ask the user again.
        request(&mut connect(&b), &b.mint_nonce(), prompt).unwrap();
        // #52: the second prompt is flagged so the dialog says "incorrect".
        assert_eq!(
            *asked.lock().unwrap(),
            vec!["/k/id".to_string(), "/k/id (retry)".to_string()]
        );
        // Later (a reconnect), the cached passphrase answers silently.
        if let Ok(mut c) = b.cache.lock() {
            c.get_mut("/k/id").unwrap().1 = None;
        }
        request(&mut connect(&b), &b.mint_nonce(), prompt).unwrap();
        assert_eq!(asked.lock().unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn cancel_is_reported_and_endpoint_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let (b, _) = test_broker(None);
        let dir_mode = std::fs::metadata(&b.dir).unwrap().permissions().mode();
        let sock_mode = std::fs::metadata(&b.endpoint).unwrap().permissions().mode();
        assert_eq!(dir_mode & 0o777, 0o700);
        assert_eq!(sock_mode & 0o777, 0o600);
        assert!(request(
            &mut connect(&b),
            &b.mint_nonce(),
            "Enter passphrase for /k: "
        )
        .is_none());
        assert!(b.take_cancelled());
        assert!(!b.take_cancelled());
        let dir = b.dir.clone();
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
    fn ssh_env_mints_a_fresh_per_connection_nonce() {
        let (b, _) = test_broker(Some("never-in-env"));
        let env1 = b.ssh_env();
        let env2 = b.ssh_env();
        // Each spawn gets a distinct nonce.
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
        assert_ne!(n1, n2, "ssh_env must mint a fresh nonce per spawn");
        // And neither is the static session token (which only names the
        // private endpoint dir and is never a valid wire credential).
        let session_token: std::ffi::OsString = b.token.as_str().into();
        assert_ne!(n1, session_token);
        assert_ne!(n2, session_token);
    }

    #[test]
    fn ssh_env_carries_no_passphrase() {
        let (b, _) = test_broker(Some("never-in-env"));
        let env = b.ssh_env();
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
    fn nonce_stays_valid_for_wrong_passphrase_retry() {
        // A given ssh child keeps one nonce in its environment. OpenSSH
        // invokes the askpass helper again in the same process after a wrong
        // passphrase; the second request must succeed with the same nonce.
        let (b, _) = test_broker(Some("pw"));
        let nonce = b.mint_nonce();
        let prompt = "Enter passphrase for key '/k/id': ";
        // First request succeeds.
        request(&mut connect(&b), &nonce, prompt).unwrap();
        // Second request with the same nonce also succeeds (retry).
        request(&mut connect(&b), &nonce, prompt).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn nonce_is_refused_after_attempt_cap() {
        // A nonce is accepted at most MAX_NONCE_ATTEMPTS times.
        let (b, _) = test_broker(Some("pw"));
        let nonce = b.mint_nonce();
        let prompt = "Enter passphrase for key '/k/id': ";
        // Use up the cap.
        for _ in 0..MAX_NONCE_ATTEMPTS {
            assert!(
                request(&mut connect(&b), &nonce, prompt).is_some(),
                "within cap"
            );
        }
        // The next attempt is refused.
        assert!(
            request(&mut connect(&b), &nonce, prompt).is_none(),
            "over cap"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_expired_nonce_is_refused() {
        let (b, _) = test_broker(Some("pw"));
        let prompt = "Enter passphrase for key '/k/id': ";
        let nonce = b.mint_nonce();
        let Some(old) = Instant::now().checked_sub(NONCE_TTL + Duration::from_secs(1)) else {
            return;
        };
        b.nonces.lock().unwrap().insert(nonce.clone(), (old, 0));
        assert!(
            request(&mut connect(&b), &nonce, prompt).is_none(),
            "a nonce older than the lifetime must be refused"
        );
        assert!(b.nonces.lock().unwrap().get(&nonce).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn minting_past_the_cap_drops_the_oldest_nonce() {
        let (b, _) = test_broker(Some("pw"));
        let prompt = "Enter passphrase for key '/k/id': ";
        let first = b.mint_nonce();
        if let Some(t) = Instant::now().checked_sub(Duration::from_secs(10)) {
            b.nonces.lock().unwrap().insert(first.clone(), (t, 0));
        }
        let mut last = String::new();
        for _ in 0..MAX_NONCES {
            last = b.mint_nonce();
        }
        assert!(b.nonces.lock().unwrap().len() <= MAX_NONCES);
        assert!(
            request(&mut connect(&b), &first, prompt).is_none(),
            "the oldest nonce is dropped once the cap is reached"
        );
        assert!(request(&mut connect(&b), &last, prompt).is_some());
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
        let prompt = "Enter passphrase for key '/k/id': ";
        let nonce = b.mint_nonce();
        assert!(request(&mut connect(&b), &nonce, prompt).is_some());
        b.refuse_peers
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(
            request(&mut connect(&b), &nonce, prompt).is_none(),
            "a refused peer must not get an answer even with a valid nonce"
        );
    }
}
