#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::sync::Mutex;
use std::time::Duration;

use server::{HabblaudServer, ServerError};
use tauri::{AppHandle, Manager, RunEvent};

struct AppState {
  server: Mutex<Option<HabblaudServer>>,
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(AppState {
      server: Mutex::new(None),
    })
    .setup(|app| {
      let handle = app.handle().clone();
      std::thread::spawn(move || {
        if let Err(err) = boot_office(handle) {
          eprintln!("[habblaud-desktop] failed to start office: {err}");
        }
      });
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building Habblaud desktop")
    .run(|app_handle, event| {
      if let RunEvent::Exit = event {
        if let Some(state) = app_handle.try_state::<AppState>() {
          if let Ok(mut guard) = state.server.lock() {
            if let Some(server) = guard.take() {
              server.stop();
            }
          }
        }
      }
    });
}

fn boot_office(app: AppHandle) -> Result<(), ServerError> {
  let server = HabblaudServer::start(&app)?;
  let url = server.url();
  server.wait_until_ready(Duration::from_secs(45))?;

  if let Some(state) = app.try_state::<AppState>() {
    if let Ok(mut guard) = state.server.lock() {
      *guard = Some(server);
    }
  }

  let parsed = url.parse().expect("valid office url");
  if let Some(window) = app.get_webview_window("main") {
    if let Err(err) = window.navigate(parsed) {
      eprintln!("[habblaud-desktop] failed to navigate to office UI: {err}");
    }
  }

  Ok(())
}
