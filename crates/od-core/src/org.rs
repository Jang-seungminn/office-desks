//! The org chart (departments and which projects sit in them). Port of `bridge/src/org.ts`.
//!
//! It is the user's own setup, so it lives in a small JSON file in the Office Desks home: every
//! browser sees the same office. File access is synchronous; async callers use `spawn_blocking`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::fsio;
use crate::home::office_home;
use crate::jsstr;
use crate::model::{Department, DepartmentTheme, OrgChart};

const MAX_DEPARTMENTS: usize = 20;
const MAX_NAME: usize = 20;

/// `<home>/.office-desks/org.json` for an explicit home, else `<office home>/org.json`.
pub fn org_file(home: Option<&Path>, env: &HashMap<String, String>) -> PathBuf {
    match home {
        Some(h) => h.join(".office-desks").join("org.json"),
        None => office_home(env).join("org.json"),
    }
}

fn theme_of(v: Option<&Value>) -> DepartmentTheme {
    match v.and_then(Value::as_str) {
        Some("dev") => DepartmentTheme::Dev,
        Some("design") => DepartmentTheme::Design,
        Some("research") => DepartmentTheme::Research,
        Some("ops") => DepartmentTheme::Ops,
        _ => DepartmentTheme::Etc,
    }
}

/// `/^[a-z0-9-]{1,40}$/`
fn valid_id(s: &str) -> bool {
    (1..=40).contains(&s.len())
        && s.bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// `d-` plus 8 random base-36 characters (the TS `Math.random().toString(36).slice(2, 10)`).
pub fn random_department_id() -> String {
    let mut b = [0u8; 8];
    // A failing OS rng is not worth failing a save over: fall back to the clock.
    if getrandom::fill(&mut b).is_err() {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        for (i, x) in b.iter_mut().enumerate() {
            *x = (n >> (i * 8)) as u8;
        }
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let id: String = b.iter().map(|x| digits[*x as usize % 36] as char).collect();
    format!("d-{id}")
}

/// Validate and normalise an org chart coming from the browser (or a hand-edited file).
/// Errors are the user-facing messages; the server answers 400 `{ "error": message }`.
pub fn sanitize_org(raw: &Value) -> Result<OrgChart, String> {
    sanitize_org_with(raw, &mut random_department_id)
}

/// Like [`sanitize_org`] with the id generator injected.
pub fn sanitize_org_with(
    raw: &Value,
    new_id: &mut dyn FnMut() -> String,
) -> Result<OrgChart, String> {
    let Some(list) = raw.get("departments").and_then(Value::as_array) else {
        return Err("departments must be a list".into());
    };
    if list.len() > MAX_DEPARTMENTS {
        return Err(format!("부서는 {MAX_DEPARTMENTS}개까지 만들 수 있어요"));
    }
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut taken: HashSet<String> = HashSet::new();
    let mut departments = Vec::with_capacity(list.len());
    for d in list {
        let name = d
            .get("name")
            .and_then(Value::as_str)
            .map(jsstr::collapse_ws)
            .unwrap_or_default();
        if name.is_empty() || jsstr::utf16_len(&name) > MAX_NAME {
            return Err(format!("부서 이름은 1~{MAX_NAME}자로 지어 주세요"));
        }
        let theme = theme_of(d.get("theme"));
        let mut id = d
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| valid_id(s))
            .unwrap_or("")
            .to_string();
        if id.is_empty() || seen_ids.contains(&id) {
            id = new_id();
        }
        seen_ids.insert(id.clone());
        // A project sits in one department only: the first one that claims it wins.
        let repo_ids = d
            .get("repoIds")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .filter(|r| !r.is_empty() && jsstr::utf16_len(r) <= 200)
            .filter(|r| taken.insert((*r).to_string()))
            .map(str::to_string)
            .collect();
        departments.push(Department {
            id,
            name,
            theme,
            repo_ids,
        });
    }
    Ok(OrgChart { departments })
}

/// A missing, unreadable or broken file is an empty org chart.
pub fn load_org(file: &Path) -> OrgChart {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| sanitize_org(&v).ok())
        .unwrap_or(OrgChart {
            departments: Vec::new(),
        })
}

pub fn save_org(org: &OrgChart, file: &Path) -> std::io::Result<()> {
    let body = serde_json::to_string_pretty(org).map_err(std::io::Error::other)?;
    fsio::save_atomic(file, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dept(id: &str, name: &str, theme: DepartmentTheme, repos: &[&str]) -> Department {
        Department {
            id: id.into(),
            name: name.into(),
            theme,
            repo_ids: repos.iter().map(|s| s.to_string()).collect(),
        }
    }

    // org.test.ts: normalises names, themes and ids, and seats a project in one department only
    #[test]
    fn normalises_names_themes_and_ids_and_seats_a_project_in_one_department_only() {
        let out = sanitize_org(&json!({
            "departments": [
                { "id": "d-a", "name": "  개발   팀 ", "theme": "dev", "repoIds": ["r1", "r2"] },
                { "id": "d-a", "name": "디자인", "theme": "nope", "repoIds": ["r2", "r3", 42] },
            ]
        }))
        .unwrap();
        assert_eq!(
            out.departments[0],
            dept("d-a", "개발 팀", DepartmentTheme::Dev, &["r1", "r2"])
        );
        assert_ne!(out.departments[1].id, "d-a");
        assert!(out.departments[1].id.starts_with("d-"));
        assert_eq!(out.departments[1].name, "디자인");
        assert_eq!(out.departments[1].theme, DepartmentTheme::Etc);
        assert_eq!(out.departments[1].repo_ids, vec!["r3"]);
    }

    // org.test.ts: rejects bad input
    #[test]
    fn rejects_bad_input_with_the_ts_messages() {
        assert_eq!(
            sanitize_org(&Value::Null).unwrap_err(),
            "departments must be a list"
        );
        assert_eq!(
            sanitize_org(&json!({ "departments": [{ "name": "" }] })).unwrap_err(),
            "부서 이름은 1~20자로 지어 주세요"
        );
        assert!(sanitize_org(&json!({ "departments": [{ "name": "x".repeat(21) }] })).is_err());
        let many: Vec<Value> = (0..21)
            .map(|i| json!({ "name": format!("d{i}") }))
            .collect();
        assert_eq!(
            sanitize_org(&json!({ "departments": many })).unwrap_err(),
            "부서는 20개까지 만들 수 있어요"
        );
    }

    #[test]
    fn edge_inputs_follow_js_semantics() {
        for bad in [
            json!(5),
            json!([]),
            json!("x"),
            json!({ "departments": "x" }),
        ] {
            assert!(sanitize_org(&bad).is_err());
        }
        // Non-object entries and non-string names have no name.
        assert!(sanitize_org(&json!({ "departments": [null] })).is_err());
        assert!(sanitize_org(&json!({ "departments": [{ "name": 5 }] })).is_err());
        // Name length counts UTF-16 units: 10 astral characters are 20 units, 11 are 22.
        assert!(sanitize_org(&json!({ "departments": [{ "name": "😀".repeat(10) }] })).is_ok());
        assert!(sanitize_org(&json!({ "departments": [{ "name": "😀".repeat(11) }] })).is_err());
        // Ids: anchored, lowercase only, at most 40; otherwise generated.
        let mut n = 0;
        let mut gen = || {
            n += 1;
            format!("d-gen{n}")
        };
        let out = sanitize_org_with(
            &json!({ "departments": [
                { "id": "UPPER", "name": "a" },
                { "id": "ok-1\n", "name": "b" },
                { "id": "a".repeat(41), "name": "c" },
                { "id": "a".repeat(40), "name": "d" },
                { "name": "e" },
            ] }),
            &mut gen,
        )
        .unwrap();
        let ids: Vec<_> = out.departments.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids[0], "d-gen1");
        assert_eq!(ids[1], "d-gen2");
        assert_eq!(ids[2], "d-gen3");
        assert_eq!(ids[3], "a".repeat(40));
        assert_eq!(ids[4], "d-gen4");
        // repoIds: empty, over-long and duplicate ids are dropped; a repeat in the same list too.
        let out = sanitize_org(&json!({ "departments": [
            { "id": "x", "name": "a", "repoIds": ["", "a", "a", "b".repeat(201), "c"] },
            { "id": "y", "name": "b", "repoIds": "nope" },
        ] }))
        .unwrap();
        assert_eq!(out.departments[0].repo_ids, vec!["a", "c"]);
        assert!(out.departments[1].repo_ids.is_empty());
    }

    #[test]
    fn random_ids_look_like_d_plus_eight_base36() {
        let id = random_department_id();
        assert_eq!(id.len(), 10);
        assert!(valid_id(&id));
        assert_ne!(id, random_department_id());
    }

    // org.test.ts: round-trips through the file and survives a missing or broken one
    #[test]
    fn round_trips_through_the_file_and_survives_a_missing_or_broken_one() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("sub").join("org.json");
        assert!(load_org(&file).departments.is_empty());
        let org = OrgChart {
            departments: vec![dept("d-x", "X", DepartmentTheme::Ops, &["r"])],
        };
        save_org(&org, &file).unwrap();
        assert_eq!(load_org(&file), org);
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(raw, serde_json::to_value(&org).unwrap());
        std::fs::write(&file, "{ not json").unwrap();
        assert!(load_org(&file).departments.is_empty());
        // A hand-edited file is sanitised on load.
        std::fs::write(
            &file,
            r#"{"departments":[{"name":"  a   b ","theme":"dev"}]}"#,
        )
        .unwrap();
        assert_eq!(load_org(&file).departments[0].name, "a b");
        // Pretty-printed with two spaces, like JSON.stringify(org, null, 2).
        save_org(&org, &file).unwrap();
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .starts_with("{\n  \"departments\": ["));
    }

    #[test]
    fn org_file_locations() {
        let env = HashMap::from([("OFFICE_DESKS_HOME".to_string(), "/x".to_string())]);
        assert_eq!(org_file(None, &env), PathBuf::from("/x").join("org.json"));
        assert_eq!(
            org_file(Some(Path::new("/h")), &env),
            PathBuf::from("/h").join(".office-desks").join("org.json")
        );
    }
}
