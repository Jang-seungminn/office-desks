#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Agent hooks run `<this exe> hook-relay`: nothing else may start first (no GUI, no runtime).
    if od_app::hook_relay_requested(std::env::args_os()) {
        std::process::exit(od_core::native::hook_relay::run());
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| {
            eprintln!("[gongbang] {e}");
            std::process::exit(1)
        });
    tauri::async_runtime::set(runtime.handle().clone());
    let env = od_core::native::env::process_env();
    let core = match runtime.block_on(od_app::start(&env, 0, od_app::app_config(&env))) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[gongbang] {e}");
            std::process::exit(1)
        }
    };
    od_app::gui::run(core);
}
