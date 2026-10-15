//! Crash-recovery store (autosave, phase 1).
//!
//! While a document is dirty the frontend writes a small envelope here, under
//! the app's data directory, so an unsaved edit survives a crash or a power
//! loss. The envelope carries the whole `.csx` document (it *is* the recovery)
//! plus enough metadata for a "Recover unsaved work" dialog.
//!
//! Filesystem-only and Tauri-free on purpose: the commands in `lib.rs` resolve
//! the base directory and delegate here, so this stays unit-testable and the
//! webview never needs broad filesystem-write permission.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Envelope format id/version (recovery files are ours; not the `.csx` format).
const RECOVERY_FORMAT: &str = "csim-recovery";
const RECOVERY_VERSION: u32 = 1;

/// One recovery copy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Recovery {
    /// Always [`RECOVERY_FORMAT`].
    pub format: String,
    /// Always [`RECOVERY_VERSION`].
    pub version: u32,
    /// Original file path, or `None` for a document never saved to disk.
    pub path: Option<String>,
    /// Document name (shown in the recovery dialog).
    pub name: String,
    /// Last edit label at flush time (the undo label), for context.
    pub label: String,
    /// Wall-clock time (ms since the Unix epoch) the copy was written.
    pub at_ms: u64,
    /// The document, exactly as `.csx` JSON.
    pub document: serde_json::Value,
}

/// Summary of a stored recovery (what the dialog lists).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecoveryMeta {
    /// Storage key — pass back to `read`/`discard`.
    pub key: String,
    pub path: Option<String>,
    pub name: String,
    pub label: String,
    pub at_ms: u64,
}

/// A recovery envelope built from the frontend's request.
pub fn envelope(
    path: Option<String>,
    name: String,
    label: String,
    at_ms: u64,
    document: serde_json::Value,
) -> Recovery {
    Recovery {
        format: RECOVERY_FORMAT.to_string(),
        version: RECOVERY_VERSION,
        path,
        name,
        label,
        at_ms,
        document,
    }
}

/// The recovery subdirectory under the app data directory.
pub fn dir(base: &Path) -> PathBuf {
    base.join("recovery")
}

/// Stable storage key for a document: a hash of its file path, or a
/// caller-supplied id for a document that has never been saved.
pub fn key_for(path: Option<&str>, doc_key: &str) -> String {
    match path {
        Some(p) if !p.trim().is_empty() => format!("f{}", fnv1a_hex(normalize(p).as_bytes())),
        _ => format!("n{}", sanitize(doc_key)),
    }
}

/// Write (or replace) the recovery copy for `key`, atomically.
pub fn write(base: &Path, key: &str, recovery: &Recovery) -> std::io::Result<()> {
    std::fs::create_dir_all(dir(base))?;
    let json = serde_json::to_string_pretty(recovery).unwrap_or_else(|_| "{}".to_string());
    csim_core::format::write_atomic(&path_for(base, key), &format!("{json}\n"))
}

/// Every recovery copy on disk, newest first. A corrupt or foreign file is
/// skipped, never fatal — a broken scratch file must not block startup.
pub fn list(base: &Path) -> Vec<RecoveryMeta> {
    let Ok(entries) = std::fs::read_dir(dir(base)) else {
        return Vec::new();
    };
    let mut out: Vec<RecoveryMeta> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(rec) = serde_json::from_str::<Recovery>(&text) else {
            continue;
        };
        if rec.format != RECOVERY_FORMAT || rec.version != RECOVERY_VERSION {
            continue;
        }
        out.push(RecoveryMeta {
            key: path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: rec.path,
            name: rec.name,
            label: rec.label,
            at_ms: rec.at_ms,
        });
    }
    out.sort_by_key(|m| std::cmp::Reverse(m.at_ms));
    out
}

/// The stored document JSON for `key` (`None` when absent or unreadable).
pub fn read(base: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(path_for(base, key)).ok()?;
    let rec: Recovery = serde_json::from_str(&text).ok()?;
    if rec.format != RECOVERY_FORMAT {
        return None;
    }
    Some(serde_json::to_string(&rec.document).unwrap_or_default())
}

/// Remove one recovery copy. `Ok(true)` when a file was actually removed.
pub fn discard(base: &Path, key: &str) -> std::io::Result<bool> {
    match std::fs::remove_file(path_for(base, key)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Recovery file path for `key`. Keys are generated by [`key_for`], so they
/// are filename-safe by construction; `sanitize` guards a hand-supplied key.
fn path_for(base: &Path, key: &str) -> PathBuf {
    dir(base).join(format!("{}.json", sanitize(key)))
}

/// Lowercase on case-insensitive filesystems so moves that only change case
/// (or separators) map to the same key.
fn normalize(path: &str) -> String {
    let p = path.replace('\\', "/");
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p
    }
}

pub(crate) fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "session".to_string()
    } else {
        cleaned
    }
}

/// FNV-1a 64-bit, hex — a short, stable, dependency-free path hash.
pub(crate) fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("csim-recovery-{}-{tag}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rec(path: Option<&str>, name: &str, at: u64) -> Recovery {
        envelope(
            path.map(|p| p.to_string()),
            name.to_string(),
            "Placed gate.and".to_string(),
            at,
            serde_json::json!({ "format": "circuitsim-plus-plus", "version": 3 }),
        )
    }

    #[test]
    fn write_list_read_discard_roundtrip() {
        let base = tmp("roundtrip");
        let key = key_for(Some("/home/me/alu.csx"), "ignored");
        write(&base, &key, &rec(Some("/home/me/alu.csx"), "alu", 100)).unwrap();

        let listed = list(&base);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].key, key);
        assert_eq!(listed[0].name, "alu");
        assert_eq!(listed[0].at_ms, 100);

        let doc = read(&base, &key).expect("stored document");
        assert!(doc.contains("circuitsim-plus-plus"), "{doc}");

        assert!(discard(&base, &key).unwrap());
        assert!(list(&base).is_empty());
        assert!(!discard(&base, &key).unwrap()); // idempotent
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn unnamed_documents_use_the_caller_id_and_survive_a_restart() {
        let base = tmp("unnamed");
        let key = key_for(None, "session-abc");
        assert_eq!(key, "nsession-abc");
        write(&base, &key, &rec(None, "untitled", 7)).unwrap();
        // A fresh `list` (as on the next launch) still finds it.
        let listed = list(&base);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_is_newest_first() {
        let base = tmp("order");
        write(
            &base,
            &key_for(Some("/a.csx"), ""),
            &rec(Some("/a.csx"), "a", 10),
        )
        .unwrap();
        write(
            &base,
            &key_for(Some("/b.csx"), ""),
            &rec(Some("/b.csx"), "b", 30),
        )
        .unwrap();
        write(
            &base,
            &key_for(Some("/c.csx"), ""),
            &rec(Some("/c.csx"), "c", 20),
        )
        .unwrap();
        let at: Vec<u64> = list(&base).iter().map(|m| m.at_ms).collect();
        assert_eq!(at, vec![30, 20, 10]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn corrupt_and_foreign_files_are_skipped_not_fatal() {
        let base = tmp("corrupt");
        let key = key_for(Some("/good.csx"), "");
        write(&base, &key, &rec(Some("/good.csx"), "good", 5)).unwrap();
        std::fs::write(dir(&base).join("garbage.json"), "{not json").unwrap();
        std::fs::write(
            dir(&base).join("other.json"),
            r#"{"format":"something-else","version":1}"#,
        )
        .unwrap();
        let listed = list(&base);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].key, key);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_newer_write_replaces_the_previous_copy() {
        let base = tmp("replace");
        let key = key_for(Some("/x.csx"), "");
        write(&base, &key, &rec(Some("/x.csx"), "first", 1)).unwrap();
        write(&base, &key, &rec(Some("/x.csx"), "second", 2)).unwrap();
        let listed = list(&base);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "second");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn keys_are_filename_safe_and_stable() {
        // A path with separators / spaces / colons must still yield a safe key,
        // and the same path must map to the same key every time.
        let k1 = key_for(Some("C:\\Users\\me\\My Circuits\\a b.csx"), "");
        let k2 = key_for(Some("C:\\Users\\me\\My Circuits\\a b.csx"), "");
        assert_eq!(k1, k2);
        assert!(k1.starts_with('f'));
        assert!(k1[1..].chars().all(|c| c.is_ascii_hexdigit()));
        // A caller id is sanitized into the key.
        assert_eq!(key_for(None, "a/b:c"), "na_b_c");
    }
}
