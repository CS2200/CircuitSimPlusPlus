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

use crate::api::{LoadError, LoadErrorKind, SimMode};

pub mod rle;
pub mod validate;

/// Value of the `format` field (§5.1 versioning).
pub const FORMAT_NAME: &str = "circuitsim-plus-plus";
/// Current `version` field value.
pub const FORMAT_VERSION: u32 = 2;

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

/// Document-wide settings (§5.2). `delay_model` is the interactive default;
/// the autograder pins `Delay` regardless (§4.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// Interactive delay model (`delayModel`); the autograder pins `Delay`
    /// regardless (§4.4).
    pub delay_model: SimMode,
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
    #[serde(default)]
    pub points: Vec<[i32; 2]>,
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
pub fn load_document(bytes: &[u8]) -> Result<Document, Vec<LoadError>> {
    let doc: Document = match serde_json::from_slice(bytes) {
        Ok(d) => d,
        Err(e) => {
            return Err(vec![LoadError {
                kind: LoadErrorKind::Parse,
                message: format!("invalid .csx JSON: {e}"),
                circuit: String::new(),
                comp_id: None,
                wire_idx: None,
            }])
        }
    };
    let errors = validate::validate(&doc);
    if errors.is_empty() {
        Ok(doc)
    } else {
        Err(errors)
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
            "version": 2,
            "name": "round-trip",
            "settings": { "delayModel": "delay", "clockHz": 1, "delayTable": "cs2200-74ls-v1" },
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
            points: vec![[0, 0]; n],
        };
        assert_eq!(w(0).segment_count(), 1);
        assert_eq!(w(2).segment_count(), 1);
        assert_eq!(w(4).segment_count(), 3);
    }
}
