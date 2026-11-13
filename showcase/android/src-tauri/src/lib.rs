// Roamies on a phone. The app is the phone page (showcase/phone.html and the shared creature files) in a WebView;
// the page talks to the brain itself, over the phone bridge (sidecar/bridge.mjs). Nothing here yet but the window:
// the phone's own brain, voice and reminders arrive as plugins.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Roamies");
}
