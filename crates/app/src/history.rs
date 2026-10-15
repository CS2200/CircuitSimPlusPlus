//! Version store (autosave phase 2).
//!
//! One rolling history per document, under the app data directory, sharing the
//! crash-recovery store's document key (so history and recovery agree on what
//! "this document" is). Each version is a small metadata entry in a
//! per-document index plus a **content-addressed** blob of the canonical
//! `.csx` text — identical states share one blob, and a save that changes
//! nothing adds nothing.
//!
//! Retention: named versions are never evicted; automatic versions are capped
//! by count and by a per-document byte budget, oldest first.
//!
//! Filesystem-only and Tauri-free on purpose (the commands in `lib.rs` resolve
//! the base directory), so this stays unit-testable.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::recovery::{fnv1a_hex, sanitize};

const HISTORY_FORMAT: &str = "csim-history";
const HISTORY_VERSION: u32 = 1;
/// Automatic versions kept per document (named versions are never evicted).
pub const KEEP_AUTO: usize = 50;
/// Per-document byte budget for automatic versions.
pub const BUDGET_BYTES: u64 = 25 * 1024 * 1024;

/// One stored version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VersionMeta {
    /// Stable, sortable id (a per-document counter as a decimal string).
    pub id: String,
    pub at_ms: u64,
    pub label: String,
    /// Promoted by the user: exempt from retention.
    pub named: bool,
    /// Blob file stem (content hash).
    pub hash: String,
    /// Canonical text length.
    pub bytes: u64,
}

/// The result of a snapshot request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    /// The version that now holds this state.
    pub id: String,
    /// Nothing changed since the previous version — no version was added.
    pub deduped: bool,
    /// Folded into the previous (recent, automatic) version.
    pub coalesced: bool,
}

/// Total history footprint (the Settings readout).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub bytes: u64,
    pub documents: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Index {
    format: String,
    version: u32,
    next_id: u64,
    /// Oldest first.
    versions: Vec<VersionMeta>,
}

impl Default for Index {
    fn default() -> Self {
        Index {
            format: HISTORY_FORMAT.to_string(),
            version: HISTORY_VERSION,
            next_id: 0,
            versions: Vec::new(),
        }
    }
}

// -- paths ------------------------------------------------------------------

fn root(base: &Path) -> PathBuf {
    base.join("history")
}

fn doc_dir(base: &Path, key: &str) -> PathBuf {
    root(base).join(sanitize(key))
}

fn index_path(base: &Path, key: &str) -> PathBuf {
    doc_dir(base, key).join("index.json")
}

fn blob_dir_of(dir: &Path) -> PathBuf {
    dir.join("blobs")
}

fn blob_dir(base: &Path, key: &str) -> PathBuf {
    blob_dir_of(&doc_dir(base, key))
}

fn blob_path(base: &Path, key: &str, hash: &str) -> PathBuf {
    blob_dir(base, key).join(format!("{hash}.csx"))
}

// -- index io ---------------------------------------------------------------

/// Load a document's index. An absent, unreadable, or foreign index reads as
/// empty — a damaged scratch file must never be fatal (the blobs are orphaned
/// and collected on the next write).
fn load_index(base: &Path, key: &str) -> Index {
    std::fs::read_to_string(index_path(base, key))
        .ok()
        .and_then(|text| serde_json::from_str::<Index>(&text).ok())
        .filter(|i| i.format == HISTORY_FORMAT && i.version == HISTORY_VERSION)
        .unwrap_or_default()
}

fn save_index(base: &Path, key: &str, index: &Index) -> std::io::Result<()> {
    std::fs::create_dir_all(doc_dir(base, key))?;
    let json = serde_json::to_string_pretty(index).unwrap_or_else(|_| "{}".to_string());
    csim_core::format::write_atomic(&index_path(base, key), &format!("{json}\n"))
}

/// Write a blob unless it is already present (content addressing).
fn write_blob(base: &Path, key: &str, hash: &str, text: &str) -> std::io::Result<()> {
    let path = blob_path(base, key, hash);
    if path.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(blob_dir(base, key))?;
    csim_core::format::write_atomic(&path, text)
}

/// Delete blobs no live version references.
fn gc_blobs(base: &Path, key: &str, index: &Index) -> std::io::Result<()> {
    let dir = blob_dir(base, key);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    let keep: std::collections::BTreeSet<&str> =
        index.versions.iter().map(|v| v.hash.as_str()).collect();
    for entry in entries.flatten() {
        let path = entry.path();
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if !keep.contains(stem) {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

// -- retention --------------------------------------------------------------

fn auto_count(index: &Index) -> usize {
    index.versions.iter().filter(|v| !v.named).count()
}

fn auto_bytes(index: &Index) -> u64 {
    index
        .versions
        .iter()
        .filter(|v| !v.named)
        .map(|v| v.bytes)
        .sum()
}

/// Evict the oldest automatic versions until both caps are satisfied.
fn prune(index: &mut Index) {
    while auto_count(index) > KEEP_AUTO || auto_bytes(index) > BUDGET_BYTES {
        let Some(pos) = index.versions.iter().position(|v| !v.named) else {
            break; // every remaining version is named — never evict those
        };
        index.versions.remove(pos);
    }
}

// -- operations -------------------------------------------------------------

/// Record `text` (canonical `.csx`) as this document's newest version.
///
/// `coalesce_ms > 0` folds the write into the previous version when it is
/// automatic and younger than the window — that is what stops a burst of
/// autosaves from filling the history with near-identical entries. A write
/// whose content already matches the head is a no-op (`deduped`).
pub fn snapshot(
    base: &Path,
    key: &str,
    text: &str,
    label: &str,
    at_ms: u64,
    coalesce_ms: u64,
) -> std::io::Result<Snapshot> {
    let mut index = load_index(base, key);
    let hash = fnv1a_hex(text.as_bytes());
    let bytes = text.len() as u64;
    let head = index.versions.last().cloned();

    if let Some(head) = head {
        if head.hash == hash && !head.named {
            return Ok(Snapshot {
                id: head.id,
                deduped: true,
                coalesced: false,
            });
        }
        let recent =
            coalesce_ms > 0 && !head.named && at_ms.saturating_sub(head.at_ms) < coalesce_ms;
        if recent {
            write_blob(base, key, &hash, text)?;
            if let Some(last) = index.versions.last_mut() {
                last.at_ms = at_ms;
                last.label = label.to_string();
                last.hash = hash;
                last.bytes = bytes;
            }
            save_index(base, key, &index)?;
            gc_blobs(base, key, &index)?;
            return Ok(Snapshot {
                id: head.id,
                deduped: false,
                coalesced: true,
            });
        }
    }

    write_blob(base, key, &hash, text)?;
    let id = index.next_id.to_string();
    index.next_id += 1;
    index.versions.push(VersionMeta {
        id: id.clone(),
        at_ms,
        label: label.to_string(),
        named: false,
        hash,
        bytes,
    });
    prune(&mut index);
    save_index(base, key, &index)?;
    gc_blobs(base, key, &index)?;
    Ok(Snapshot {
        id,
        deduped: false,
        coalesced: false,
    })
}

/// Move a document's history to another key — used when a file is renamed or
/// moved, since history is keyed by path (D1). Returns false when the source
/// had no history; an existing target history is replaced.
pub fn rename(base: &Path, from_key: &str, to_key: &str) -> std::io::Result<bool> {
    let from = doc_dir(base, from_key);
    if !from.exists() {
        return Ok(false);
    }
    let to = doc_dir(base, to_key);
    if to.exists() {
        std::fs::remove_dir_all(&to)?;
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)?;
    Ok(true)
}

/// Every version for a document, newest first.
pub fn list(base: &Path, key: &str) -> Vec<VersionMeta> {
    let mut versions = load_index(base, key).versions;
    versions.reverse();
    versions
}

/// The canonical `.csx` text of one version (`None` when absent/unreadable).
pub fn read(base: &Path, key: &str, id: &str) -> Option<String> {
    let index = load_index(base, key);
    let meta = index.versions.iter().find(|v| v.id == id)?;
    std::fs::read_to_string(blob_path(base, key, &meta.hash)).ok()
}

/// Promote a version to "named" with a user label (exempt from retention).
pub fn name(base: &Path, key: &str, id: &str, label: &str) -> std::io::Result<bool> {
    let mut index = load_index(base, key);
    let Some(version) = index.versions.iter_mut().find(|v| v.id == id) else {
        return Ok(false);
    };
    version.named = true;
    version.label = label.to_string();
    save_index(base, key, &index)?;
    Ok(true)
}

/// Delete one version (`true` when it existed).
pub fn delete(base: &Path, key: &str, id: &str) -> std::io::Result<bool> {
    let mut index = load_index(base, key);
    let before = index.versions.len();
    index.versions.retain(|v| v.id != id);
    if index.versions.len() == before {
        return Ok(false);
    }
    save_index(base, key, &index)?;
    gc_blobs(base, key, &index)?;
    Ok(true)
}

/// Drop a document's whole history (`true` when there was something to drop).
pub fn clear(base: &Path, key: &str) -> std::io::Result<bool> {
    let dir = doc_dir(base, key);
    if !dir.exists() {
        return Ok(false);
    }
    std::fs::remove_dir_all(dir)?;
    Ok(true)
}

/// Total bytes and document count across every stored history.
pub fn usage(base: &Path) -> Usage {
    let mut out = Usage {
        bytes: 0,
        documents: 0,
    };
    let Ok(entries) = std::fs::read_dir(root(base)) else {
        return out;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if !index_path_of(&dir).exists() {
            continue; // not a document directory
        }
        out.documents += 1;
        if let Ok(files) = std::fs::read_dir(&dir) {
            for f in files.flatten() {
                if let Ok(m) = f.metadata() {
                    if m.is_file() {
                        out.bytes += m.len();
                    }
                }
            }
        }
        if let Ok(blobs) = std::fs::read_dir(blob_dir_of(&dir)) {
            for b in blobs.flatten() {
                if let Ok(m) = b.metadata() {
                    out.bytes += m.len();
                }
            }
        }
    }
    out
}

fn index_path_of(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("csim-history-{}-{tag}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn doc(name: &str) -> String {
        format!(
            "{{\n  \"format\": \"circuitsim-plus-plus\",\n  \"version\": 3,\n  \"name\": {name:?},\n  \"settings\": {{}}\n}}\n"
        )
    }

    #[test]
    fn snapshot_list_read_roundtrip_newest_first() {
        let base = tmp("roundtrip");
        let a = snapshot(&base, "k", &doc("a"), "Placed gate.and", 100, 0).unwrap();
        let b = snapshot(&base, "k", &doc("b"), "Wired net", 200, 0).unwrap();
        assert!(!a.deduped && !a.coalesced);

        let listed = list(&base, "k");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, b.id); // newest first
        assert_eq!(listed[0].label, "Wired net");
        assert_eq!(listed[1].id, a.id);

        assert_eq!(read(&base, "k", &a.id).unwrap(), doc("a"));
        assert!(read(&base, "k", "nope").is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn identical_content_dedupes_and_adds_nothing() {
        let base = tmp("dedupe");
        let first = snapshot(&base, "k", &doc("same"), "Saved", 100, 0).unwrap();
        let again = snapshot(&base, "k", &doc("same"), "Saved", 200, 0).unwrap();
        assert!(again.deduped);
        assert_eq!(again.id, first.id);
        assert_eq!(list(&base, "k").len(), 1);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_recent_automatic_version_coalesces() {
        let base = tmp("coalesce");
        let first = snapshot(&base, "k", &doc("v1"), "Edit", 1_000, 60_000).unwrap();
        // Inside the window: folds into the same version.
        let second = snapshot(&base, "k", &doc("v2"), "Edit", 30_000, 60_000).unwrap();
        assert!(second.coalesced);
        assert_eq!(second.id, first.id);
        let listed = list(&base, "k");
        assert_eq!(listed.len(), 1);
        assert_eq!(read(&base, "k", &first.id).unwrap(), doc("v2")); // latest state

        // Outside the window: a genuinely new version.
        let third = snapshot(&base, "k", &doc("v3"), "Edit", 200_000, 60_000).unwrap();
        assert!(!third.coalesced);
        assert_eq!(list(&base, "k").len(), 2);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn naming_is_kept_and_exempt_from_retention() {
        let base = tmp("named");
        let keep = snapshot(&base, "k", &doc("keep"), "Milestone", 0, 0).unwrap();
        assert!(name(&base, "k", &keep.id, "Before refactor").unwrap());
        // Flood automatic versions past both caps.
        for i in 0..(KEEP_AUTO + 10) {
            snapshot(
                &base,
                "k",
                &doc(&format!("auto{i}")),
                "Edit",
                10_000 + i as u64,
                0,
            )
            .unwrap();
        }
        let listed = list(&base, "k");
        let named: Vec<_> = listed.iter().filter(|v| v.named).collect();
        assert_eq!(named.len(), 1);
        assert_eq!(named[0].label, "Before refactor");
        assert!(
            listed.len() <= KEEP_AUTO + 1,
            "kept {} versions",
            listed.len()
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn delete_drops_the_version_and_reclaims_its_blob() {
        let base = tmp("delete");
        let a = snapshot(&base, "k", &doc("a"), "a", 1, 0).unwrap();
        let _b = snapshot(&base, "k", &doc("b"), "b", 2, 0).unwrap();
        let blobs_before = std::fs::read_dir(blob_dir(&base, "k")).unwrap().count();
        assert_eq!(blobs_before, 2);

        assert!(delete(&base, "k", &a.id).unwrap());
        assert!(!delete(&base, "k", &a.id).unwrap()); // already gone
        assert_eq!(list(&base, "k").len(), 1);
        assert_eq!(std::fs::read_dir(blob_dir(&base, "k")).unwrap().count(), 1);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn clear_removes_a_whole_document_history() {
        let base = tmp("clear");
        snapshot(&base, "k", &doc("a"), "a", 1, 0).unwrap();
        assert!(clear(&base, "k").unwrap());
        assert!(list(&base, "k").is_empty());
        assert!(!clear(&base, "k").unwrap()); // nothing left
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_corrupt_index_reads_as_empty_without_losing_new_writes() {
        let base = tmp("corrupt");
        snapshot(&base, "k", &doc("a"), "a", 1, 0).unwrap();
        std::fs::write(index_path(&base, "k"), "{ not json").unwrap();
        assert!(list(&base, "k").is_empty());
        // Still usable: a new snapshot writes a fresh index.
        snapshot(&base, "k", &doc("b"), "b", 2, 0).unwrap();
        assert_eq!(list(&base, "k").len(), 1);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn rename_moves_a_document_history_to_its_new_key() {
        let base = tmp("rename");
        let a = snapshot(&base, "old", &doc("a"), "a", 1, 0).unwrap();
        assert!(rename(&base, "old", "new").unwrap());
        assert!(list(&base, "old").is_empty());
        let moved = list(&base, "new");
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].id, a.id);
        // The blobs came along, so the version still reads back.
        assert_eq!(read(&base, "new", &a.id).unwrap(), doc("a"));
        // A key with no history is a no-op, not an error.
        assert!(!rename(&base, "missing", "elsewhere").unwrap());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn usage_counts_documents_and_bytes() {
        let base = tmp("usage");
        assert_eq!(
            usage(&base),
            Usage {
                bytes: 0,
                documents: 0
            }
        );
        snapshot(&base, "k1", &doc("a"), "a", 1, 0).unwrap();
        snapshot(&base, "k2", &doc("b"), "b", 1, 0).unwrap();
        let u = usage(&base);
        assert_eq!(u.documents, 2);
        assert!(u.bytes > 0);
        std::fs::remove_dir_all(&base).ok();
    }
}
