use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use thiserror::Error;

const DEFAULT_PORT: u16 = 4747;
const DEFAULT_HOST: &str = "127.0.0.1";

#[derive(Debug, Error)]
pub enum ServerError {
  #[error("Node.js was not found on PATH. Install Node 22.12+ and try again.")]
  NodeMissing,
  #[error("Habblaud server entry was not found at {0}")]
  EntryMissing(PathBuf),
  #[error("failed to start Habblaud server: {0}")]
  Spawn(#[from] std::io::Error),
  #[error("Habblaud server did not become ready in time at http://{DEFAULT_HOST}:{DEFAULT_PORT}")]
  Timeout,
  #[error("Habblaud root was not found")]
  RootMissing,
}

pub struct HabblaudServer {
  child: Option<Child>,
  port: u16,
  owned: bool,
}

impl HabblaudServer {
  pub fn start(app: &AppHandle) -> Result<Self, ServerError> {
    let port = std::env::var("HABBLAUD_PORT")
      .ok()
      .and_then(|v| v.parse::<u16>().ok())
      .filter(|p| *p > 0)
      .unwrap_or(DEFAULT_PORT);

    // If something is already serving Habblaud, reuse it.
    if health_ok(port) {
      return Ok(Self {
        child: None,
        port,
        owned: false,
      });
    }

    let root = resolve_habblaud_root(app)?;
    let entry = root.join("dist").join("server").join("index.js");
    if !entry.is_file() {
      return Err(ServerError::EntryMissing(entry));
    }

    let node = find_node().ok_or(ServerError::NodeMissing)?;
    let mut command = Command::new(node);
    command
      .arg(&entry)
      .current_dir(&root)
      .env("HABBLAUD_PORT", port.to_string())
      .env("HABBLAUD_HOST", DEFAULT_HOST)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());

    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      const CREATE_NO_WINDOW: u32 = 0x0800_0000;
      command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command.spawn()?;
    Ok(Self {
      child: Some(child),
      port,
      owned: true,
    })
  }

  pub fn url(&self) -> String {
    format!("http://{DEFAULT_HOST}:{}", self.port)
  }

  pub fn wait_until_ready(&self, timeout: Duration) -> Result<(), ServerError> {
    let start = Instant::now();
    while start.elapsed() < timeout {
      if health_ok(self.port) {
        return Ok(());
      }
      thread::sleep(Duration::from_millis(250));
    }
    Err(ServerError::Timeout)
  }

  pub fn stop(mut self) {
    if !self.owned {
      return;
    }
    if let Some(mut child) = self.child.take() {
      let _ = child.kill();
      let _ = child.wait();
    }
  }
}

fn health_ok(port: u16) -> bool {
  http_health(port).unwrap_or_else(|_| {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
  })
}

fn http_health(port: u16) -> Result<bool, ()> {
  use std::io::{Read, Write};
  let addr = SocketAddr::from(([127, 0, 0, 1], port));
  let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).map_err(|_| ())?;
  stream
    .set_read_timeout(Some(Duration::from_millis(600)))
    .map_err(|_| ())?;
  stream
    .set_write_timeout(Some(Duration::from_millis(600)))
    .map_err(|_| ())?;
  let req = format!(
    "GET /api/health HTTP/1.1\r\nHost: {DEFAULT_HOST}:{port}\r\nConnection: close\r\n\r\n"
  );
  stream.write_all(req.as_bytes()).map_err(|_| ())?;
  let mut buf = Vec::new();
  let _ = stream.read_to_end(&mut buf);
  let text = String::from_utf8_lossy(&buf);
  Ok(text.contains("200") && text.contains("\"ok\":true"))
}

fn find_node() -> Option<PathBuf> {
  if let Ok(path) = std::env::var("HABBLAUD_NODE") {
    let p = PathBuf::from(path);
    if p.is_file() {
      return Some(p);
    }
  }
  which("node")
}

fn which(bin: &str) -> Option<PathBuf> {
  let path = std::env::var_os("PATH")?;
  for dir in std::env::split_paths(&path) {
    let candidate = dir.join(bin);
    if candidate.is_file() {
      return Some(candidate);
    }
    #[cfg(windows)]
    {
      let exe = dir.join(format!("{bin}.exe"));
      if exe.is_file() {
        return Some(exe);
      }
    }
  }
  None
}

fn resolve_habblaud_root(app: &AppHandle) -> Result<PathBuf, ServerError> {
  if let Ok(root) = std::env::var("HABBLAUD_ROOT") {
    let p = PathBuf::from(root);
    if looks_like_root(&p) {
      return Ok(p);
    }
  }

  // Packaged app: resources/habblaud copied beside the binary.
  if let Ok(resource_dir) = app.path().resource_dir() {
    let bundled = resource_dir.join("habblaud");
    if looks_like_root(&bundled) {
      return Ok(bundled);
    }
    if looks_like_root(&resource_dir) {
      return Ok(resource_dir);
    }
  }

  // Dev: desktop/src-tauri -> repo root.
  let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let repo = manifest_dir
    .parent()
    .and_then(|p| p.parent())
    .map(|p| p.to_path_buf())
    .ok_or(ServerError::RootMissing)?;
  if looks_like_root(&repo) {
    return Ok(repo);
  }

  Err(ServerError::RootMissing)
}

fn looks_like_root(path: &Path) -> bool {
  path.join("dist").join("server").join("index.js").is_file()
    && path.join("dist").join("client").join("index.html").is_file()
}
