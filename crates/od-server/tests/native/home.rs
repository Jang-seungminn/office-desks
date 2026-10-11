//! `native_backend` reads its registry from the env map's `OFFICE_DESKS_HOME`, not from the
//! process env (which `main` points at `<process root>/office`, a different folder).

use std::path::Path;

use libtest_mimic::{Failed, Trial};
use od_core::backend::OfficeBackend;
use serde_json::json;

use crate::contract::{build_world, path_str};

pub fn trials(root: &Path) -> Vec<Trial> {
    let sub = root.join("native_backend_uses_the_scratch_home");
    vec![Trial::test(
        "native_backend_uses_the_scratch_home",
        move || native_backend_uses_the_scratch_home(&sub),
    )]
}

fn native_backend_uses_the_scratch_home(sub: &Path) -> Result<(), Failed> {
    let setup = json!({
        "repo": {
            "files": { "README.md": "home\n" },
            "commit": {
                "name": "Home Test",
                "email": "home@example.invalid",
                "date": "2026-01-01T00:00:00Z",
                "message": "init"
            },
            "after": {}
        },
        "files": {},
        "dirs": [],
        "uploads": {}
    });
    let world = build_world(sub, &setup);
    let office = Path::new(&world.env["OFFICE_DESKS_HOME"]).to_path_buf();
    let process_office = std::env::var_os("OFFICE_DESKS_HOME").expect("process OFFICE_DESKS_HOME");
    assert_ne!(
        office.as_os_str(),
        process_office.as_os_str(),
        "the trial's office home must differ from the process one"
    );
    let state = json!({
        "version": 1,
        "repos": [{
            "id": "repo-scratch-home",
            "path": path_str(&world.root.join("repo")),
            "name": "scratch-home-repo"
        }],
        "desks": {}
    });
    std::fs::write(office.join("state.json"), state.to_string()).expect("seed state.json");

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let b = od_server::native_backend(&world.env, 1).await;
        assert_eq!(b.name(), "native");
        let snap = b.snapshot().await.expect("snapshot");
        b.dispose().await;
        let main = snap
            .desks
            .iter()
            .find(|d| d.is_main)
            .unwrap_or_else(|| panic!("the seeded repo's main desk: {snap:?}"));
        assert_eq!(main.repo_id, "repo-scratch-home");
        assert_eq!(main.repo, "scratch-home-repo");
        assert_eq!(snap.desks.len(), 1, "{snap:?}");
    });
    Ok(())
}
