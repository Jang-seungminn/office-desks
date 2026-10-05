//! tauri-build with the app manifest (the IPC commands Task 4 grants), our own Windows
//! Common-Controls manifest linked into every target, and the release guard for both UIs.

use std::path::Path;

fn main() {
    let mut attrs =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "term_config",
            "pick_folder",
            "open_office",
        ]));
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // tauri-build's own manifest goes through `embed_resource::compile`, which emits
        // `cargo:rustc-link-arg-bins`: only `gongbang.exe` would get it. Tauri imports Common
        // Controls v6, so the unit tests, the `app` trials (and their fake `claude` copies) and
        // `e2e_harness.exe` would die at load with STATUS_ENTRYPOINT_NOT_FOUND. Ours is linked
        // into every target (`cargo:rustc-link-arg`).
        // windows/app.manifest is tauri-build 2.7.1's `src/windows-app-manifest.xml` verbatim:
        // re-diff it whenever tauri-build is upgraded (Cargo.toml pins `~2.7`).
        attrs =
            attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_resource::compile_for_everything("windows/app.rc", embed_resource::NONE)
            .manifest_required()
            .expect("app manifest");
    }
    tauri_build::try_build(attrs).expect("tauri-build");

    for path in [
        "windows/app.rc",
        "windows/app.manifest",
        "../../app/dist",
        "../../web/dist",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    // rust-embed embeds whatever is there: a release built without the UIs would ship blank.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let dir = Path::new(&dir);
        for missing in ["../../app/dist/index.html", "../../web/dist/index.html"] {
            if !dir.join(missing).exists() {
                panic!(
                    "Gongbang release build: run `npm run build -w web` and `npm run build -w app` first ({missing} is missing)"
                );
            }
        }
    }
}
