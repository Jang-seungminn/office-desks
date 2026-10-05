//! Port of `bridge/src/usage.ts`: plan usage limits as Orca shows them in its status bar,
//! from `orca account list`. Only the rate-limit numbers are passed on; account emails and ids
//! stay in the backend.

use od_core::jsval;
use od_core::model::{UsageProvider, UsageSnapshot, UsageWindow};
use serde_json::Value;

/// JS `Math.round` (halves round towards +infinity).
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// `^([a-z]+)(Weekly|Monthly)$`, e.g. `opusWeekly` gives `Opus 주간`.
fn model_label(key: &str) -> Option<String> {
    let (name, suffix) = if let Some(n) = key.strip_suffix("Weekly") {
        (n, "주간")
    } else if let Some(n) = key.strip_suffix("Monthly") {
        (n, "월간")
    } else {
        return None;
    };
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    Some(format!(
        "{}{} {suffix}",
        name[..1].to_ascii_uppercase(),
        &name[1..]
    ))
}

fn label(key: &str, w: &serde_json::Map<String, Value>) -> String {
    let fixed = match key {
        "session" => Some("5시간"),
        "weekly" => Some("주간"),
        "monthly" => Some("월간"),
        "fableWeekly" => Some("Fable 주간"),
        _ => None,
    };
    if let Some(l) = fixed {
        return l.to_string();
    }
    if let Some(l) = model_label(key) {
        return l;
    }
    match w.get("windowMinutes").and_then(Value::as_f64) {
        Some(m) if m != 0.0 => format!("{}시간", js_round(m / 60.0)),
        _ => key.to_string(),
    }
}

/// session first, then weekly, then monthly, then the model-specific ones.
fn order(key: &str) -> u8 {
    match key {
        "session" => 0,
        "weekly" => 1,
        "monthly" => 2,
        _ => 3,
    }
}

/// Port of `toUsage(rateLimits, now)`.
pub fn to_usage(rate_limits: Option<&Value>, now: i64) -> UsageSnapshot {
    let mut providers = Vec::new();
    if let Some(Value::Object(all)) = rate_limits {
        for (key, raw) in all {
            let Some(p) = raw.as_object() else { continue };
            if p.get("status").and_then(Value::as_str) != Some("ok") {
                continue;
            }
            let mut windows = Vec::new();
            for (wk, wv) in p {
                let Some(w) = wv.as_object() else { continue };
                let Some(used) = w.get("usedPercent").and_then(Value::as_f64) else {
                    continue;
                };
                windows.push(UsageWindow {
                    key: wk.clone(),
                    label: label(wk, w),
                    // `+ 0.0` turns -0 into 0, as JS `Math.max(0, -0)` does.
                    used_percent: used.clamp(0.0, 100.0) + 0.0,
                    resets_at: w.get("resetsAt").and_then(Value::as_f64).map(|x| x as i64),
                    reset_description: w
                        .get("resetDescription")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
            }
            windows.sort_by_key(|w| order(&w.key));
            if windows.is_empty() {
                continue;
            }
            let provider = match p.get("provider") {
                Some(v) if !v.is_null() => jsval::string(v),
                _ => key.clone(),
            };
            providers.push(UsageProvider { provider, windows });
        }
    }
    UsageSnapshot {
        providers,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_ok_providers_in_orca_order_and_drops_everything_else() {
        let raw = json!({
            "claude": {
                "provider": "claude",
                "status": "ok",
                "fableWeekly": { "usedPercent": 9, "windowMinutes": 10080, "resetsAt": 2, "resetDescription": "Fri 3:59 AM" },
                "weekly": { "usedPercent": 21, "windowMinutes": 10080, "resetsAt": 2, "resetDescription": "Fri 3:59 AM" },
                "session": { "usedPercent": 80, "windowMinutes": 300, "resetsAt": 1, "resetDescription": "3:39 PM" },
                "usageMetadata": { "source": "oauth" }
            },
            "codex": { "provider": "codex", "status": "unavailable", "session": null, "error": "Codex CLI not found" },
            "minimaxCookieConfigured": false
        });
        let u = to_usage(Some(&raw), 5);
        assert_eq!(u.updated_at, 5);
        assert_eq!(u.providers.len(), 1);
        let got: Vec<(String, f64, Option<String>)> = u.providers[0]
            .windows
            .iter()
            .map(|w| (w.label.clone(), w.used_percent, w.reset_description.clone()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("5시간".to_string(), 80.0, Some("3:39 PM".to_string())),
                ("주간".to_string(), 21.0, Some("Fri 3:59 AM".to_string())),
                (
                    "Fable 주간".to_string(),
                    9.0,
                    Some("Fri 3:59 AM".to_string())
                ),
            ]
        );
        let s = serde_json::to_string(&u).unwrap();
        assert!(!s.contains("oauth"), "{s}");
        assert!(s.contains("\"usedPercent\":80,"), "{s}");
        assert!(s.contains("\"resetsAt\":1,"), "{s}");
    }

    #[test]
    fn labels_model_specific_windows() {
        let raw = json!({ "claude": { "provider": "claude", "status": "ok", "opusWeekly": { "usedPercent": 120, "windowMinutes": 10080 } } });
        let u = to_usage(Some(&raw), 0);
        let w = &u.providers[0].windows[0];
        assert_eq!(w.label, "Opus 주간");
        assert_eq!(w.used_percent, 100.0);
        assert_eq!(w.resets_at, None);
        assert_eq!(w.reset_description, None);
    }

    #[test]
    fn window_minutes_label_rounds_like_js_and_provider_falls_back_to_key() {
        let raw =
            json!({ "claude": { "status": "ok", "x": { "usedPercent": 1, "windowMinutes": 90 } } });
        let u = to_usage(Some(&raw), 0);
        assert_eq!(u.providers[0].provider, "claude");
        assert_eq!(u.providers[0].windows[0].label, "2시간");
    }

    #[test]
    fn no_rate_limits_gives_no_providers() {
        assert!(to_usage(None, 1).providers.is_empty());
        assert!(to_usage(Some(&json!([1])), 1).providers.is_empty());
    }

    #[test]
    fn provider_is_js_string() {
        let raw =
            json!({ "c": { "provider": 7, "status": "ok", "session": { "usedPercent": 1 } } });
        assert_eq!(to_usage(Some(&raw), 0).providers[0].provider, "7");
        let raw =
            json!({ "c": { "provider": null, "status": "ok", "session": { "usedPercent": 1 } } });
        assert_eq!(to_usage(Some(&raw), 0).providers[0].provider, "c");
    }

    #[test]
    fn labels() {
        let none = serde_json::Map::new();
        assert_eq!(label("monthly", &none), "월간");
        assert_eq!(label("sonnetMonthly", &none), "Sonnet 월간");
        assert_eq!(label("Weekly", &none), "Weekly");
        assert_eq!(label("opus4Weekly", &none), "opus4Weekly");
        let w = json!({ "windowMinutes": 0 });
        assert_eq!(label("y", w.as_object().unwrap()), "y");
        let w = json!({ "windowMinutes": 300 });
        assert_eq!(label("y", w.as_object().unwrap()), "5시간");
        let w = json!({ "windowMinutes": 29 });
        assert_eq!(label("y", w.as_object().unwrap()), "0시간");
    }

    #[test]
    fn float_resets_at_is_truncated_and_float_percent_kept() {
        let raw = json!({ "c": { "status": "ok", "weekly": { "usedPercent": 12.5, "resetsAt": 1700.9 }, "session": { "usedPercent": -3 } } });
        let u = to_usage(Some(&raw), 0);
        let w = &u.providers[0].windows;
        assert_eq!(w[0].key, "session");
        assert_eq!(w[0].used_percent, 0.0);
        assert_eq!(w[1].resets_at, Some(1700));
        let s = serde_json::to_string(&u).unwrap();
        assert!(s.contains("\"usedPercent\":12.5"), "{s}");
    }
}
