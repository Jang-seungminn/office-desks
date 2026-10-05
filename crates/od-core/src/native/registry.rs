//! Projects the user registered and the board fields Orca would otherwise keep (status,
//! comment). Port of `bridge/src/native/registry.ts`; `state.json` has the same shape.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRecord {
    pub id: String,
    /// The repo's main checkout.
    pub path: String,
    pub name: String,
    /// Unknown fields survive a load/save round-trip (TS keeps them via spread).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Fields absent from the JSON are `None`; as a patch, `None` means "leave as is".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Unknown fields survive a load/save round-trip, written after the known ones.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// A JSON object that keeps insertion order, like a JS object with non-integer keys.
#[derive(Debug, Clone, Default)]
struct Desks(Vec<(String, DeskMeta)>);

impl Desks {
    fn get(&self, id: &str) -> Option<&DeskMeta> {
        self.0.iter().find(|(k, _)| k == id).map(|(_, v)| v)
    }
    fn set(&mut self, id: &str, meta: DeskMeta) {
        match self.0.iter_mut().find(|(k, _)| k == id) {
            Some(slot) => slot.1 = meta,
            None => self.0.push((id.to_string(), meta)),
        }
    }
}

impl Serialize for Desks {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// Tolerant: entries that are not objects are dropped, non-string fields ignored.
impl<'de> Deserialize<'de> for Desks {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Desks;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object of desk metadata")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Desks, A::Error> {
                let mut desks = Desks::default();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    if let Value::Object(mut o) = v {
                        let mut take = |key: &str| match o.remove(key) {
                            Some(Value::String(s)) => Some(s),
                            _ => None,
                        };
                        let workspace_status = take("workspaceStatus");
                        let comment = take("comment");
                        desks.set(
                            &k,
                            DeskMeta {
                                workspace_status,
                                comment,
                                extra: o,
                            },
                        );
                    }
                }
                Ok(desks)
            }
        }
        d.deserialize_map(V)
    }
}

#[derive(Debug, Clone, Serialize)]
struct RegistryData {
    version: u32,
    repos: Vec<RepoRecord>,
    desks: Desks,
}

impl Default for RegistryData {
    fn default() -> Self {
        RegistryData {
            version: 1,
            repos: Vec::new(),
            desks: Desks::default(),
        }
    }
}

/// Lenient parse of `state.json`: anything unusable becomes the empty registry.
fn parse(text: &str) -> RegistryData {
    let Ok(Value::Object(mut o)) = serde_json::from_str::<Value>(text) else {
        return RegistryData::default();
    };
    let repos = match o.remove("repos") {
        Some(Value::Array(a)) => a
            .into_iter()
            .filter_map(|v| serde_json::from_value::<RepoRecord>(v).ok())
            .collect(),
        _ => Vec::new(),
    };
    let desks = o
        .remove("desks")
        .and_then(|v| serde_json::from_value::<Desks>(v).ok())
        .unwrap_or_default();
    RegistryData {
        version: 1,
        repos,
        desks,
    }
}

/// All access goes through one mutex that is held across mutation *and* the file write, so
/// concurrent saves never interleave and the last writer's data is what ends up on disk.
pub struct Registry {
    file: PathBuf,
    data: Mutex<RegistryData>,
}

impl Registry {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Registry {
            file: file.into(),
            data: Mutex::new(RegistryData::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryData> {
        // A panic mid-save must not wedge every later call.
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Read the file; a missing or corrupt one leaves an empty registry.
    pub fn load(&self) {
        let data = std::fs::read_to_string(&self.file)
            .map(|t| parse(&t))
            .unwrap_or_default();
        *self.lock() = data;
    }

    pub fn repos(&self) -> Vec<RepoRecord> {
        self.lock().repos.clone()
    }

    /// Adds the repo unless one with the same id exists, then saves.
    pub fn add_repo(&self, repo: RepoRecord) -> io::Result<()> {
        let mut data = self.lock();
        if data.repos.iter().any(|r| r.id == repo.id) {
            return Ok(());
        }
        data.repos.push(repo);
        write(&self.file, &data)
    }

    /// Empty `DeskMeta` when the desk is unknown.
    pub fn meta(&self, desk_id: &str) -> DeskMeta {
        self.lock().desks.get(desk_id).cloned().unwrap_or_default()
    }

    /// Merge `patch` over the desk's meta (`None` fields are left alone); an empty comment
    /// clears it. Then saves.
    pub fn set_meta(&self, desk_id: &str, patch: DeskMeta) -> io::Result<()> {
        let mut data = self.lock();
        let mut next = data.desks.get(desk_id).cloned().unwrap_or_default();
        if patch.workspace_status.is_some() {
            next.workspace_status = patch.workspace_status;
        }
        if patch.comment.is_some() {
            next.comment = patch.comment;
        }
        next.extra.extend(patch.extra);
        if next.comment.as_deref() == Some("") {
            next.comment = None;
        }
        data.desks.set(desk_id, next);
        write(&self.file, &data)
    }
}

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(50 * (u64::from(attempt) + 1))
}

/// Windows: a virus scanner or indexer can hold the target for a moment (EPERM/EBUSY).
pub(crate) fn is_transient_rename_error(e: &io::Error) -> bool {
    // 5 ACCESS_DENIED, 32 SHARING_VIOLATION, 33 LOCK_VIOLATION
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

/// Run `op`, retrying up to 4 more times (50 ms, 100 ms, ...) while `retryable` says so.
pub(crate) fn retry_io(
    mut op: impl FnMut() -> io::Result<()>,
    retryable: impl Fn(&io::Error) -> bool,
    sleep: impl Fn(Duration),
) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match op() {
            Ok(()) => return Ok(()),
            Err(e) if retryable(&e) && attempt < 4 => {
                sleep(retry_delay(attempt));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Write a temp file and rename it, so a crash never leaves half a file behind.
fn write(file: &Path, data: &RegistryData) -> io::Result<()> {
    if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let json = serde_json::to_string_pretty(data).map_err(io::Error::other)?;
    if let Err(e) = std::fs::write(&tmp, json) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    retry_io(
        || std::fs::rename(&tmp, file),
        |e| cfg!(windows) && is_transient_rename_error(e),
        std::thread::sleep,
    )
    .inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::sync::Arc;

    fn repo() -> RepoRecord {
        RepoRecord {
            id: "abc".into(),
            path: "/p/app".into(),
            name: "app".into(),
            extra: Default::default(),
        }
    }

    fn status(s: &str) -> DeskMeta {
        DeskMeta {
            workspace_status: Some(s.into()),
            ..Default::default()
        }
    }

    fn comment(s: &str) -> DeskMeta {
        DeskMeta {
            comment: Some(s.into()),
            ..Default::default()
        }
    }

    #[test]
    fn persists_repos_and_desk_metadata_atomically_and_reloads_them() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("state.json");
        let r = Registry::new(&file);
        r.load();
        assert!(r.repos().is_empty());
        r.add_repo(repo()).unwrap();
        r.add_repo(repo()).unwrap();
        r.set_meta(
            "abc::/p/app",
            DeskMeta {
                workspace_status: Some("in-review".into()),
                comment: Some("hi".into()),
                ..Default::default()
            },
        )
        .unwrap();
        r.set_meta("abc::/p/app", comment("")).unwrap();

        let again = Registry::new(&file);
        again.load();
        assert_eq!(again.repos(), vec![repo()]);
        assert_eq!(again.meta("abc::/p/app"), status("in-review"));
        assert_eq!(again.meta("nope"), DeskMeta::default());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        // No temp file is left behind.
        let names: Vec<_> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("state.json")]);
    }

    #[test]
    fn on_disk_shape_matches_the_node_registry() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        let r = Registry::new(&file);
        r.add_repo(repo()).unwrap();
        r.set_meta("d1", status("todo")).unwrap();
        r.set_meta("d0", comment("c")).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        // JSON.stringify(data, null, 2): 2-space indent, no trailing newline, desks in insertion order.
        let expected = r#"{
  "version": 1,
  "repos": [
    {
      "id": "abc",
      "path": "/p/app",
      "name": "app"
    }
  ],
  "desks": {
    "d1": {
      "workspaceStatus": "todo"
    },
    "d0": {
      "comment": "c"
    }
  }
}"#;
        assert_eq!(text, expected);
        let empty = tempfile::tempdir().unwrap();
        let f2 = empty.path().join("state.json");
        // An empty registry prints [] and {} like JSON.stringify.
        write(&f2, &RegistryData::default()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&f2).unwrap(),
            "{\n  \"version\": 1,\n  \"repos\": [],\n  \"desks\": {}\n}"
        );
    }

    #[test]
    fn serializes_overlapping_saves_and_keeps_the_latest_data() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        let r = Arc::new(Registry::new(&file));
        r.load();
        let mut handles: Vec<_> = (0..20)
            .map(|i| {
                let r = r.clone();
                std::thread::spawn(move || r.set_meta(&format!("d{i}"), comment(&format!("c{i}"))))
            })
            .collect();
        handles.push({
            let r = r.clone();
            std::thread::spawn(move || {
                r.set_meta("last", status("todo"))?;
                r.set_meta("last", status("done"))
            })
        });
        for h in handles {
            h.join().unwrap().unwrap();
        }
        let again = Registry::new(&file);
        again.load();
        for i in 0..20 {
            assert_eq!(again.meta(&format!("d{i}")), comment(&format!("c{i}")));
        }
        assert_eq!(again.meta("last"), status("done"));
    }

    #[test]
    fn missing_or_corrupt_file_loads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        let r = Registry::new(&file);
        r.load();
        assert!(r.repos().is_empty());
        for bad in [
            "{not json",
            "",
            "null",
            "[]",
            "5",
            r#"{"repos":"x","desks":[1]}"#,
        ] {
            std::fs::write(&file, bad).unwrap();
            let r = Registry::new(&file);
            r.load();
            assert!(r.repos().is_empty(), "{bad}");
            assert_eq!(r.meta("x"), DeskMeta::default());
        }
        // A partially valid file keeps what is usable.
        std::fs::write(
            &file,
            r#"{"version":9,"repos":[{"id":"a","path":"/a","name":"a"},7],"desks":{"d":{"comment":"c","extra":1},"e":3}}"#,
        )
        .unwrap();
        let r = Registry::new(&file);
        r.load();
        assert_eq!(r.repos().len(), 1);
        assert_eq!(r.meta("d").comment.as_deref(), Some("c"));
        assert!(r.meta("e") == DeskMeta::default()); // wrong type: dropped
    }

    #[test]
    fn unknown_fields_survive_a_load_save_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        std::fs::write(
            &file,
            r#"{"version":1,"repos":[{"id":"a","path":"/a","name":"a","color":"red"}],"desks":{"d":{"comment":"c","pinned":true,"workspaceStatus":"todo"}}}"#,
        )
        .unwrap();
        let r = Registry::new(&file);
        r.load();
        r.set_meta("d", comment("new")).unwrap();
        r.add_repo(RepoRecord {
            id: "b".into(),
            ..repo()
        })
        .unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["repos"][0]["color"], "red");
        assert_eq!(v["desks"]["d"]["pinned"], true);
        assert_eq!(v["desks"]["d"]["comment"], "new");
        // Known fields first, extras after.
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.find("\"workspaceStatus\"").unwrap() < text.find("\"pinned\"").unwrap());
        assert!(text.find("\"name\"").unwrap() < text.find("\"color\"").unwrap());
    }

    #[test]
    fn set_meta_merges_and_empty_comment_clears() {
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::new(dir.path().join("state.json"));
        r.set_meta("d", comment("hi")).unwrap();
        r.set_meta("d", status("todo")).unwrap();
        assert_eq!(
            r.meta("d"),
            DeskMeta {
                workspace_status: Some("todo".into()),
                comment: Some("hi".into()),
                ..Default::default()
            }
        );
        r.set_meta("d", comment("")).unwrap();
        assert_eq!(r.meta("d"), status("todo"));
    }

    #[test]
    fn rename_retries_transient_errors_with_backoff_then_gives_up() {
        let slept = RefCell::new(Vec::new());
        let calls = Cell::new(0);
        let busy = || io::Error::from(io::ErrorKind::PermissionDenied);
        let ok = retry_io(
            || {
                calls.set(calls.get() + 1);
                if calls.get() < 3 {
                    Err(busy())
                } else {
                    Ok(())
                }
            },
            is_transient_rename_error,
            |d| slept.borrow_mut().push(d),
        );
        assert!(ok.is_ok());
        assert_eq!(calls.get(), 3);
        assert_eq!(
            *slept.borrow(),
            vec![Duration::from_millis(50), Duration::from_millis(100)]
        );

        calls.set(0);
        let err = retry_io(
            || {
                calls.set(calls.get() + 1);
                Err(busy())
            },
            is_transient_rename_error,
            |_| {},
        );
        assert!(err.is_err());
        assert_eq!(calls.get(), 5); // first try + 4 retries

        calls.set(0);
        let err = retry_io(
            || {
                calls.set(calls.get() + 1);
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            is_transient_rename_error,
            |_| {},
        );
        assert!(err.is_err());
        assert_eq!(calls.get(), 1);
    }
}
