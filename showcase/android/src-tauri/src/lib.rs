// Roamies on a phone. The app is the phone page (showcase/phone.html and the shared creature files) in a WebView;
// the page talks to the brain itself, over the phone bridge (sidecar/bridge.mjs). Talking uses the phone's own speech
// recognition (tauri-plugin-stt), which the page reaches through the Tauri global; the phone's own brain and its
// reminders arrive as plugins.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_stt::init())
        .run(tauri::generate_context!())
        .expect("error while running Roamies");
}
