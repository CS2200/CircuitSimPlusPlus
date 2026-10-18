//! `.csx` file format v2 — serde document model, canonical serializer, and
//! load pipeline (DESIGN.md §5; BACKEND.md task B2; `docs/format-v2.md` is
//! the normative prose spec).
//!
//! Loading is `parse` → `validate` (this module's [`load_document`]); the
//! netlist builder (task B3) continues from a validated [`Document`]. Load
//! collects **all** errors and never panics (DESIGN.md §5.2).
//!
//! Canonical serialization (§5.1): 2-space indent, recursively sorted
//! object keys, every field always emitted, single trailing newline —
//! saving twice is byte-identical.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};

use crate::api::{LoadError, LoadErrorKind};

pub mod rle;
pub mod validate;

/// Value of the `format` field (§5.1 versioning).
pub const FORMAT_NAME: &str = "circuitsim-plus-plus";
/// Current `version` field value.
pub const FORMAT_VERSION: u32 = 3;

/// A whole `.csx` document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    /// Format identifier; must equal [`FORMAT_NAME`].
    pub format: String,
    /// Format version; must equal [`FORMAT_VERSION`].
    pub version: u32,
    /// Document name.
    pub name: String,
    /// Document-wide settings.
    pub settings: Settings,
    /// The `main` circuit plus any subcircuits.
    pub circuits: Vec<Circuit>,
}

/// Document-wide settings (§5.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// Interactive clock rate in Hz (`clockHz`).
    pub clock_hz: u64,
    /// Delay table id (`delayTable`), e.g. `cs2200-74ls-v1` (task B7).
    pub delay_table: String,
}

/// One circuit (the `main` circuit plus any subcircuits).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Circuit {
    /// Circuit name (unique within the document).
    pub name: String,
    /// Placed component instances.
    #[serde(default)]
    pub components: Vec<Component>,
    /// Wires (explicit edges between endpoints).
    #[serde(default)]
    pub wires: Vec<Wire>,
}

/// A placed component instance. Pins have no connectivity fields — wires
/// own connectivity (§5.1, copper-first).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Component {
    /// Author-assigned id, unique within its circuit (e.g. `"c17"`).
    pub id: String,
    /// Component type string (`type`), e.g. `gate.and`; see the registry in
    /// [`crate::components`].
    #[serde(rename = "type")]
    pub type_: String,
    /// Grid position of the component origin.
    pub pos: [i32; 2],
    /// Orientation; default east.
    #[serde(default)]
    pub rot: Rotation,
    /// Optional; REQUIRED on autograder-exposed parts (§5.2) and on
    /// `wiring.pin` components (they are the subcircuit interface).
    #[serde(default)]
    pub name: String,
    /// Cosmetic side for this part's name label (UI_OVERHAUL §28): one of
    /// `N`/`E`/`S`/`W` (the same compass letters as `rot`). Absent → the
    /// app's display preference. Purely presentational: the engine ignores
    /// it beyond round-tripping it. Omitted when unset so existing files stay
    /// byte-identical.
    #[serde(default, rename = "namePos", skip_serializing_if = "Option::is_none")]
    pub name_pos: Option<Rotation>,
    /// Type-specific attributes, validated against the component registry.
    #[serde(default)]
    pub attrs: Map<String, Json>,
}

/// Component orientation (default east).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Rotation {
    /// North.
    N,
    /// East (default).
    #[default]
    E,
    /// South.
    S,
    /// West.
    W,
}

/// A wire: one explicit edge between two endpoints (§5.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wire {
    /// First endpoint.
    pub a: Endpoint,
    /// Second endpoint.
    pub b: Endpoint,
    /// Drawn polyline from endpoint `a` to endpoint `b` (absolute grid
    /// coordinates, endpoints' attachment points included). Empty means a
    /// straight line between the computed attachment points.
    ///
    /// Coordinates are fractional-friendly: component pins can sit on
    /// half-grid (or finer) positions, so drawn geometry is not
    /// integer-only. Canonical serialization still emits whole values as
    /// JSON integers (`[[1, 2]]`, never `[[1.0, 2.0]]`) so files written
    /// before fractional support stay byte-identical.
    #[serde(default, with = "wire_points")]
    pub points: Vec<[f64; 2]>,
    /// Optional cosmetic stroke color (`#rrggbb`, docs/format-v2.md §2).
    /// Purely presentational: the engine ignores it beyond round-tripping
    /// it. Omitted when unset so uncolored files stay byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Serde wire-points codec: parses any finite JSON numbers, serializes
/// whole values as integers (canonical-form stability).
mod wire_points {
    use serde::de::Error as _;
    use serde::ser::SerializeSeq;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    /// One coordinate; whole values serialize as JSON integers.
    struct Coord(f64);

    impl Serialize for Coord {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            if self.0.fract() == 0.0 && self.0.abs() < 9.0e15 {
                s.serialize_i64(self.0 as i64)
            } else {
                s.serialize_f64(self.0)
            }
        }
    }

    impl<'de> Deserialize<'de> for Coord {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            let v = f64::deserialize(d)?;
            if !v.is_finite() {
                return Err(D::Error::custom("wire coordinate must be finite"));
            }
            Ok(Coord(v))
        }
    }

    pub fn serialize<S: Serializer>(points: &[[f64; 2]], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(points.len()))?;
        for p in points {
            seq.serialize_element(&(Coord(p[0]), Coord(p[1])))?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<[f64; 2]>, D::Error> {
        let raw = Vec::<[Coord; 2]>::deserialize(d)?;
        Ok(raw.into_iter().map(|p| [p[0].0, p[1].0]).collect())
    }
}

impl Wire {
    /// Number of addressable segments for `join` endpoints: a wire with
    /// `k` points has `k - 1` segments; an empty `points` implies one
    /// straight segment.
    pub fn segment_count(&self) -> u32 {
        self.points.len().max(2) as u32 - 1
    }
}

/// A wire endpoint: either a component pin or a junction onto a segment of
/// another wire (§5.2). At least one endpoint of every wire is a pin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Endpoint {
    /// Endpoint attached to a component pin.
    Pin(PinEndpoint),
    /// Endpoint junctioned onto a segment of another wire.
    Join(JoinEndpoint),
}

impl Endpoint {
    /// `(comp, pin)` if this endpoint is a pin.
    pub fn as_pin(&self) -> Option<(&str, &str)> {
        match self {
            Endpoint::Pin(p) => Some((&p.comp, &p.pin)),
            Endpoint::Join(_) => None,
        }
    }

    /// The join reference if this endpoint is a junction.
    pub fn as_join(&self) -> Option<&JoinRef> {
        match self {
            Endpoint::Pin(_) => None,
            Endpoint::Join(j) => Some(&j.join),
        }
    }
}

/// Wire endpoint attached to a component pin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinEndpoint {
    /// Component id (unique within its circuit).
    pub comp: String,
    /// Pin name on that component.
    pub pin: String,
}

/// Wire endpoint junctioned onto a segment of another wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinEndpoint {
    /// Junction target (wire index + segment).
    pub join: JoinRef,
}

/// A junction onto `segment` of the circuit's wire index `wire`
/// (0-based segments of the target wire's polyline).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinRef {
    /// Index of the target wire within its circuit.
    pub wire: u32,
    /// 0-based segment index of the target wire's polyline.
    pub segment: u32,
}

/// Parse and validate a `.csx` document. On success returns the document;
/// on failure the **complete** error list (§5.2 — never panics, never
/// partially loads).
///
/// Documents written before the current [`FORMAT_VERSION`] are migrated
/// first (§5.1 versioning): v2 → v3 drops the removed `settings.delayModel`
/// field (there is only one engine now, the delay-aware one). Files that
/// already match the current version parse directly.
pub fn load_document(bytes: &[u8]) -> Result<Document, Vec<LoadError>> {
    let mut raw: Json = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return Err(vec![parse_error(format!("invalid .csx JSON: {e}"))]),
    };
    migrate(&mut raw);
    let doc: Document = match serde_json::from_value(raw) {
        Ok(d) => d,
        Err(e) => return Err(vec![parse_error(format!("invalid .csx JSON: {e}"))]),
    };
    let errors = validate::validate(&doc);
    if errors.is_empty() {
        Ok(doc)
    } else {
        Err(errors)
    }
}

/// A `.csx` JSON parse failure.
fn parse_error(message: String) -> LoadError {
    LoadError {
        kind: LoadErrorKind::Parse,
        message,
        circuit: String::new(),
        comp_id: None,
        wire_idx: None,
    }
}

/// Apply the version-migration chain in place (§5.1). Unknown or newer
/// versions are left untouched, so `validate` reports them.
fn migrate(v: &mut Json) {
    if v.get("version").and_then(Json::as_u64) == Some(2) {
        // v2 → v3:
        //  - drops `settings.delayModel` (`"zero" | "delay"`) — the
        //    zero-delay engine was removed, so every file is delay-aware;
        //  - drops the per-instance `attrs.delay` override — timing is
        //    unit-wide now (the delay table alone).
        if let Some(settings) = v.get_mut("settings").and_then(Json::as_object_mut) {
            settings.remove("delayModel");
        }
        if let Some(circuits) = v.get_mut("circuits").and_then(Json::as_array_mut) {
            for c in circuits {
                if let Some(comps) = c.get_mut("components").and_then(Json::as_array_mut) {
                    for comp in comps {
                        if let Some(attrs) = comp.get_mut("attrs").and_then(Json::as_object_mut) {
                            attrs.remove("delay");
                        }
                    }
                }
            }
        }
        v["version"] = Json::from(FORMAT_VERSION);
    }
}

/// Canonical serialization (§5.1): 2-space indent, recursively sorted
/// object keys, trailing newline. Byte-identical across saves.
///
/// Note: object keys are sorted explicitly rather than relying on
/// `serde_json`'s map backing, so canonical form is stable even if some
/// dependency enables the `preserve_order` feature.
pub fn to_canonical_json(doc: &Document) -> String {
    let mut v = serde_json::to_value(doc).expect("Document serialization cannot fail");
    canonicalize(&mut v);
    let mut s = serde_json::to_string_pretty(&v).expect("Document serialization cannot fail");
    s.push('\n');
    s
}

/// Write `contents` to `path` **atomically**: a sibling temp file is written,
/// flushed to disk, then renamed over the target. A crash (or a full disk)
/// can therefore never leave a truncated `.csx` — the old bytes survive until
/// the rename replaces them, and the temp file is removed on failure.
///
/// The temp file lives in the target's own directory so the rename stays on
/// one filesystem (rename is only atomic within one).
pub fn write_atomic(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write as _;

    let dir = path.parent().filter(|p| !p.as_os_str().is_empty());
    let tmp: std::path::PathBuf = match dir {
        Some(d) => d.join(temp_file_name(path)),
        None => std::path::PathBuf::from(temp_file_name(path)),
    };
    let do_write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?; // durability before the rename publishes it
        Ok(())
    };
    if let Err(e) = do_write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    // Best-effort: fsync the directory so the rename itself is durable.
    // (Opening a directory as a File fails on Windows — skipped there.)
    if let Some(d) = dir {
        if let Ok(f) = std::fs::File::open(d) {
            let _ = f.sync_all();
        }
    }
    Ok(())
}

/// Unique sibling temp name: `.<name>.<pid>.<n>.tmp`.
fn temp_file_name(path: &std::path::Path) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let stem = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "circuit.csx".to_string());
    format!(
        ".{stem}.{}.{}.tmp",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// The single save implementation: parse, canonicalize, and write a document
/// JSON value to `path` atomically. Used by `session::save_circuit` and the
/// shell's autosave command, so both paths are byte-identical.
///
/// **A document with validation problems is still written**, and those problems
/// come back as warnings: refusing the write means a student mid-edit loses a
/// draft, and the last *clean* save is still recoverable from version history.
/// A document that does not even parse is refused outright, so a broken
/// in-memory value can never clobber a good file with garbage.
pub fn save_json_atomic(path: &str, document: &Json) -> Result<Vec<LoadError>, Vec<LoadError>> {
    let (text, warnings) = canonical_document_lenient(document)?;
    write_atomic(std::path::Path::new(path), &text).map_err(|e| {
        vec![LoadError {
            kind: LoadErrorKind::Io,
            message: format!("{path}: {e}"),
            circuit: String::new(),
            comp_id: None,
            wire_idx: None,
        }]
    })?;
    Ok(warnings)
}

/// Parse, validate, and canonicalize a document JSON value into `.csx` text.
///
/// The version store uses this so history snapshots are byte-identical to what
/// a save would write (and therefore dedupe by content hash). Unlike a save, a
/// snapshot *is* refused for an invalid document: history records clean states.
pub fn canonical_document(document: &Json) -> Result<String, Vec<LoadError>> {
    let (text, warnings) = canonical_document_lenient(document)?;
    if warnings.is_empty() {
        Ok(text)
    } else {
        Err(warnings)
    }
}

/// As [`canonical_document`], but the validation problems come back as warnings
/// instead of failing the call. `Err` means the value is not a `.csx` document
/// at all — there is nothing sane to write.
pub fn canonical_document_lenient(
    document: &Json,
) -> Result<(String, Vec<LoadError>), Vec<LoadError>> {
    let doc: Document = match serde_json::from_value(document.clone()) {
        Ok(d) => d,
        Err(e) => {
            return Err(vec![parse_error(format!("invalid document: {e}"))]);
        }
    };
    let warnings = validate::validate(&doc);
    Ok((to_canonical_json(&doc), warnings))
}

/// Recursively sort object keys; arrays keep their order.
fn canonicalize(v: &mut Json) {
    match v {
        Json::Object(map) => {
            let mut entries: Vec<(String, Json)> = std::mem::take(map).into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            for val in entries.iter_mut().map(|(_, v)| v) {
                canonicalize(val);
            }
            *map = entries.into_iter().collect();
        }
        Json::Array(arr) => arr.iter_mut().for_each(canonicalize),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A representative document: two circuits (one used as a subcircuit),
    /// joins, attrs, defaults.
    fn sample_doc() -> Document {
        let json = r#"{
            "format": "circuitsim-plus-plus",
            "version": 3,
            "name": "round-trip",
            "settings": { "clockHz": 1, "delayTable": "cs2200-74ls-v1" },
            "circuits": [
                {
                    "name": "and2",
                    "components": [
                        { "id": "c0", "type": "wiring.pin", "pos": [0, 0], "name": "a", "attrs": {} },
                        { "id": "c1", "type": "wiring.pin", "pos": [0, 2], "name": "b", "attrs": {} },
                        { "id": "c2", "type": "wiring.pin", "pos": [6, 1], "name": "y", "attrs": { "isOutput": true } },
                        { "id": "c3", "type": "gate.and", "pos": [3, 1], "rot": "E", "attrs": { "inputs": 2 } }
                    ],
                    "wires": [
                        { "a": { "comp": "c0", "pin": "pin" }, "b": { "comp": "c3", "pin": "in0" }, "points": [] },
                        { "a": { "comp": "c1", "pin": "pin" }, "b": { "join": { "wire": 0, "segment": 0 } }, "points": [[1, 2], [1, 1]] },
                        { "a": { "comp": "c3", "pin": "out" }, "b": { "comp": "c2", "pin": "pin" }, "points": [[4, 1], [5, 1]] }
                    ]
                },
                {
                    "name": "main",
                    "components": [
                        { "id": "c0", "type": "subcircuit", "pos": [10, 10], "rot": "W", "name": "", "attrs": { "circuit": "and2" } },
                        { "id": "c1", "type": "wiring.probe", "pos": [16, 10], "name": "out", "attrs": { "bitsize": 1 } }
                    ],
                    "wires": [
                        { "a": { "comp": "c0", "pin": "y" }, "b": { "comp": "c1", "pin": "in" }, "points": [] }
                    ]
                }
            ]
        }"#;
        load_document(json.as_bytes()).expect("sample doc must load")
    }

    #[test]
    fn roundtrip_parse_serialize_parse() {
        let doc = sample_doc();
        let text = to_canonical_json(&doc);
        let doc2: Document = serde_json::from_str(&text).unwrap();
        assert_eq!(doc, doc2);
    }

    /// `write_atomic` replaces the target in one step and never litters the
    /// directory with temp files (a crash-safe save is the point).
    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("csim-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.csx");

        write_atomic(&path, "first contents\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first contents\n");
        // Overwrite: the old bytes are fully replaced (a shorter write must
        // not leave a tail of the previous content).
        write_atomic(&path, "x\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x\n");

        let leftover: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftover.is_empty(), "temp files left behind: {leftover:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A document with VALIDATION problems is still written — losing a draft is
    /// worse — and the problems come back as warnings. Only a document that
    /// does not even parse is refused, so a broken in-memory value cannot
    /// clobber a good file with garbage.
    #[test]
    fn save_json_atomic_writes_with_warnings_but_refuses_garbage() {
        let dir = std::env::temp_dir().join(format!("csim-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.csx");
        let text = to_canonical_json(&sample_doc());
        write_atomic(&path, &text).unwrap();

        // Unparseable (a foreign document): refused, target untouched.
        let garbage = serde_json::json!({ "format": "not-circuitsim" });
        let errors = save_json_atomic(path.to_str().unwrap(), &garbage).unwrap_err();
        assert!(!errors.is_empty());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);

        // Parseable but invalid (an unnamed `wiring.pin`): written, reported.
        let mut draft = serde_json::to_value(sample_doc()).unwrap();
        draft["circuits"][0]["components"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "id": "pin1", "type": "wiring.pin", "pos": [0, 0] }));
        let warnings = save_json_atomic(path.to_str().unwrap(), &draft).unwrap();
        assert!(!warnings.is_empty(), "the unnamed pin is reported");
        assert!(warnings[0].message.contains("wiring.pin"), "{warnings:?}");
        // The draft DID reach the file.
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("wiring.pin"));

        // …while a history snapshot of the same draft is still refused (history
        // records clean states only).
        assert!(canonical_document(&draft).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// v2 → v3 migration: a v2 file's `settings.delayModel` and any
    /// per-instance `attrs.delay` override are dropped and the document
    /// loads as the current version (always delay-aware; timing unit-wide).
    #[test]
    fn v2_document_migrates_dropping_delay_model() {
        let v2 = r#"{
            "format": "circuitsim-plus-plus",
            "version": 2,
            "name": "old",
            "settings": { "delayModel": "zero", "clockHz": 1, "delayTable": "cs2200-74ls-v1" },
            "circuits": [{ "name": "main", "components": [
                { "id": "c0", "type": "gate.not", "pos": [0, 0], "attrs": { "delay": 3 } }
            ], "wires": [] }]
        }"#;
        let doc = load_document(v2.as_bytes()).expect("a v2 file must migrate");
        assert_eq!(doc.version, FORMAT_VERSION);
        let out = to_canonical_json(&doc);
        assert!(!out.contains("delayModel"), "{out}");
        assert!(!out.contains("\"delay\""), "{out}");
        // Canonical output is already current-version and re-loads cleanly.
        assert_eq!(load_document(out.as_bytes()).unwrap(), doc);
    }

    /// v1 predates the migration chain and is rejected.
    #[test]
    fn v1_document_is_rejected() {
        let v1 = r#"{
            "format": "circuitsim-plus-plus", "version": 1, "name": "x",
            "settings": { "clockHz": 1, "delayTable": "cs2200-74ls-v1" },
            "circuits": []
        }"#;
        assert!(load_document(v1.as_bytes()).is_err());
    }

    /// Wire colors (docs/format-v2.md §2): purely cosmetic, absent when
    /// unset (so uncolored files stay byte-identical) and round-tripped
    /// when set.
    #[test]
    fn wire_color_is_optional_and_roundtrips() {
        let text = to_canonical_json(&sample_doc());
        assert!(
            !text.contains("\"color\""),
            "uncolored wires must not emit color"
        );

        let mut v: Json = serde_json::from_str(&text).unwrap();
        v["circuits"][0]["wires"][0]["color"] = Json::String("#ff0000".into());
        let colored = format!("{}\n", serde_json::to_string_pretty(&v).unwrap());

        let doc = load_document(colored.as_bytes()).expect("a colored wire must load");
        let out = to_canonical_json(&doc);
        assert!(out.contains("\"color\": \"#ff0000\""), "{out}");
        let reparsed = load_document(out.as_bytes()).expect("canonical color must reload");
        assert_eq!(reparsed, doc);
    }

    #[test]
    fn name_pos_is_optional_and_roundtrips() {
        let text = to_canonical_json(&sample_doc());
        assert!(
            !text.contains("\"namePos\""),
            "unspecified labels must not emit namePos"
        );

        let mut v: Json = serde_json::from_str(&text).unwrap();
        v["circuits"][0]["components"][3]["namePos"] = Json::String("S".into());
        let sided = format!("{}\n", serde_json::to_string_pretty(&v).unwrap());

        let doc = load_document(sided.as_bytes()).expect("a sided label must load");
        let out = to_canonical_json(&doc);
        assert!(out.contains("\"namePos\": \"S\""), "{out}");
        let reparsed = load_document(out.as_bytes()).expect("canonical namePos must reload");
        assert_eq!(reparsed, doc);
    }

    /// `namePos` reuses the compass enum, so an unknown side is a load error
    /// (never a silently-ignored label).
    #[test]
    fn name_pos_rejects_unknown_side() {
        let mut v: Json = serde_json::from_str(&to_canonical_json(&sample_doc())).unwrap();
        v["circuits"][0]["components"][3]["namePos"] = Json::String("up".into());
        let bad = format!("{}\n", serde_json::to_string_pretty(&v).unwrap());
        assert!(load_document(bad.as_bytes()).is_err());
    }

    #[test]
    fn canonical_form_is_stable_and_sorted() {
        let doc = sample_doc();
        let once = to_canonical_json(&doc);
        // Re-parse and re-serialize: byte-identical.
        let reparsed = load_document(once.as_bytes()).unwrap();
        let twice = to_canonical_json(&reparsed);
        assert_eq!(once, twice);
        // Sorted keys, 2-space indent, trailing newline.
        assert!(once.ends_with("}\n"));
        assert!(once.contains("\n  \"circuits\": ["));
        let name_pos = once.find("\"name\"").unwrap();
        let settings_pos = once.find("\"settings\"").unwrap();
        let version_pos = once.find("\"version\"").unwrap();
        assert!(name_pos < settings_pos && settings_pos < version_pos);
        // Defaults are emitted explicitly (name: "", points: []).
        assert!(once.contains("\"name\": \"\""));
        assert!(once.contains("\"points\": []"));
    }

    #[test]
    fn untagged_endpoints() {
        let pin: Endpoint = serde_json::from_str(r#"{"comp":"c1","pin":"out"}"#).unwrap();
        assert_eq!(pin.as_pin(), Some(("c1", "out")));
        let join: Endpoint = serde_json::from_str(r#"{"join":{"wire":0,"segment":1}}"#).unwrap();
        assert_eq!(
            join.as_join(),
            Some(&JoinRef {
                wire: 0,
                segment: 1
            })
        );
    }

    #[test]
    fn wire_segment_count() {
        let w = |n: usize| Wire {
            a: Endpoint::Pin(PinEndpoint {
                comp: "x".into(),
                pin: "out".into(),
            }),
            b: Endpoint::Pin(PinEndpoint {
                comp: "y".into(),
                pin: "in".into(),
            }),
            points: vec![[0.0, 0.0]; n],
            color: None,
        };
        assert_eq!(w(0).segment_count(), 1);
        assert_eq!(w(2).segment_count(), 1);
        assert_eq!(w(4).segment_count(), 3);
    }

    #[test]
    fn fractional_wire_points_roundtrip_with_integral_canonical_form() {
        // Half-grid coordinates parse; whole values canonicalize as
        // integers, so pre-fractional files stay byte-identical.
        let json = r#"{
            "format": "circuitsim-plus-plus",
            "version": 3,
            "name": "frac",
            "settings": { "clockHz": 1, "delayTable": "cs2200-74ls-v1" },
            "circuits": [{
                "name": "main",
                "components": [
                    { "id": "c0", "type": "wiring.pin", "pos": [0, 0], "name": "a" },
                    { "id": "c1", "type": "gate.not", "pos": [4, 0] }
                ],
                "wires": [
                    { "a": { "comp": "c0", "pin": "pin" }, "b": { "comp": "c1", "pin": "in" },
                      "points": [[2, 0.5], [4, 0.5], [4, 1]] }
                ]
            }]
        }"#;
        let doc = load_document(json.as_bytes()).expect("fractional points must load");
        assert_eq!(doc.circuits[0].wires[0].points[1], [4.0, 0.5]);
        let text = to_canonical_json(&doc);
        // Whole values emit as JSON integers; fractional ones as floats.
        let v: Json = serde_json::from_str(&text).unwrap();
        let pts = v["circuits"][0]["wires"][0]["points"].clone();
        assert_eq!(pts[0][0].as_i64(), Some(2));
        assert_eq!(pts[1][0].as_i64(), Some(4));
        assert_eq!(pts[1][1].as_f64(), Some(0.5));
        let back = load_document(text.as_bytes()).expect("canonical output must reload");
        assert_eq!(doc, back);
    }

    #[test]
    fn non_finite_wire_points_are_rejected() {
        // JSON has no NaN/Infinity literals, but out-of-f64-range numbers
        // must fail parsing rather than silently saturate.
        let json = r#"{
            "format": "circuitsim-plus-plus",
            "version": 3,
            "name": "bad",
            "settings": { "clockHz": 1, "delayTable": "cs2200-74ls-v1" },
            "circuits": [{
                "name": "main",
                "components": [
                    { "id": "c0", "type": "wiring.pin", "pos": [0, 0], "name": "a" },
                    { "id": "c1", "type": "gate.not", "pos": [4, 0] }
                ],
                "wires": [
                    { "a": { "comp": "c0", "pin": "pin" }, "b": { "comp": "c1", "pin": "in" },
                      "points": [[1e999, 0]] }
                ]
            }]
        }"#;
        assert!(load_document(json.as_bytes()).is_err());
    }
}
