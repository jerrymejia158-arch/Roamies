// Desktop entry, for running the phone page in a window while working on it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    roamies_phone_lib::run()
}
