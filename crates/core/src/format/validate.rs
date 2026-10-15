//! Load-time document validation (DESIGN.md §5.2; BACKEND.md task B2).
//!
//! Collects **all** errors; never panics; never partially loads. Checks,
//! in order:
//!
//! 1. `format` / `version` header values.
//! 2. Circuit names unique.
//! 3. Per circuit: component ids unique; component `name`s unique;
//!    `wiring.pin` components named (they are the subcircuit interface);
//!    component type known and attrs valid (see [`crate::components`]).
//! 4. Per wire: endpoint comp refs resolve; pin names resolve (subcircuit
//!    pins resolve against the referenced circuit's named `wiring.pin`s);
//!    join refs resolve (target wire exists, not the wire itself, segment
//!    in range); at least one endpoint is a pin.
//! 5. Subcircuit hierarchy acyclic and within the nesting depth cap
//!    (§11).
//!
//! Bitsize agreement per derived net is checked later, at netlist build
//! (task B3): a subcircuit instance's pin widths are only known after
//! flattening. It is still a *load-time* error for the user.
//!
//! Convention: `LoadError.comp_id` is the component's index in the named
//! circuit's `components` array (document order), so the frontend can map
//! errors back to its own document model; `wire_idx` is the wire's index
//! in `wires`.

use std::collections::{BTreeMap, BTreeSet};

use crate::api::{CompId, LoadError, LoadErrorKind, WireIdx};
use crate::components;

use super::{Document, FORMAT_NAME, FORMAT_VERSION};

/// Subcircuit nesting depth cap (DESIGN.md §11).
pub const MAX_HIERARCHY_DEPTH: usize = 64;

/// Validate a parsed document. Returns the complete error list (empty =
/// valid).
pub fn validate(doc: &Document) -> Vec<LoadError> {
    let mut errors = Vec::new();
    check_header(doc, &mut errors);
    check_settings(doc, &mut errors);
    check_circuit_names(doc, &mut errors);
    for circuit in &doc.circuits {
        validate_circuit(doc, circuit, &mut errors);
    }
    check_hierarchy(doc, &mut errors);
    errors
}

fn err(errors: &mut Vec<LoadError>, kind: LoadErrorKind, circuit: &str, message: String) {
    errors.push(LoadError {
        kind,
        message,
        circuit: circuit.to_string(),
        comp_id: None,
        wire_idx: None,
    });
}

fn check_header(doc: &Document, errors: &mut Vec<LoadError>) {
    if doc.format != FORMAT_NAME {
        err(
            errors,
            LoadErrorKind::Other,
            "",
            format!("unknown format '{}', expected '{FORMAT_NAME}'", doc.format),
        );
    }
    if doc.version != FORMAT_VERSION {
        err(
            errors,
            LoadErrorKind::Other,
            "",
            format!(
                "unsupported format version {} (this build understands {FORMAT_VERSION})",
                doc.version
            ),
        );
    }
}

/// `settings.delayTable` must name a published delay table (task B7) —
/// an unknown name is a clean load error, never a silent default.
fn check_settings(doc: &Document, errors: &mut Vec<LoadError>) {
    if let Err(e) = crate::timing_table::TimingTable::builtin(&doc.settings.delay_table) {
        err(
            errors,
            LoadErrorKind::Other,
            "",
            format!("settings.delayTable: {e}"),
        );
    }
}

fn check_circuit_names(doc: &Document, errors: &mut Vec<LoadError>) {
    let mut seen = BTreeSet::new();
    for circuit in &doc.circuits {
        if !seen.insert(&circuit.name) {
            err(
                errors,
                LoadErrorKind::DuplicateName,
                &circuit.name,
                format!("duplicate circuit name '{}'", circuit.name),
            );
        }
    }
}

/// Per-component info gathered in pass 1, used for wire resolution in
/// pass 2. `pins` is `None` when the pin set is unknowable (unknown type,
/// or a subcircuit whose target circuit is missing) — pin-name checks on
/// such components are skipped to avoid cascades of secondary errors.
struct CompInfo {
    pins: Option<BTreeSet<String>>,
}

fn validate_circuit(doc: &Document, circuit: &super::Circuit, errors: &mut Vec<LoadError>) {
    let cname = &circuit.name;

    // Circuit lookup for subcircuit pin resolution (first occurrence wins;
    // duplicates are already reported).
    let circuit_by_name: BTreeMap<&str, &super::Circuit> = {
        let mut m = BTreeMap::new();
        for c in &doc.circuits {
            m.entry(c.name.as_str()).or_insert(c);
        }
        m
    };

    // Pass 1: per-component checks, gather pin sets.
    let mut by_id: BTreeMap<&str, CompInfo> = BTreeMap::new();
    let mut seen_names: BTreeSet<&str> = BTreeSet::new();
    for (idx, comp) in circuit.components.iter().enumerate() {
        if by_id.contains_key(comp.id.as_str()) {
            err(
                errors,
                LoadErrorKind::DuplicateId,
                cname,
                format!("duplicate component id '{}'", comp.id),
            );
        }

        if !comp.name.is_empty() && !seen_names.insert(&comp.name) {
            err(
                errors,
                LoadErrorKind::DuplicateName,
                cname,
                format!("duplicate component name '{}'", comp.name),
            );
        }
        if comp.type_ == "wiring.pin" && comp.name.is_empty() {
            err(
                errors,
                LoadErrorKind::Other,
                cname,
                format!(
                    "component '{}': wiring.pin components must be named — they form the subcircuit interface",
                    comp.id
                ),
            );
        }

        let pins = if comp.type_ == "subcircuit" {
            // Base validation (string 'circuit' attr) plus pin resolution
            // against the referenced circuit's named pins.
            let base = components::validate_component(
                cname,
                idx,
                &comp.id,
                &comp.type_,
                &comp.attrs,
                errors,
            );
            match comp.attrs.get("circuit").and_then(|v| v.as_str()) {
                Some(target) => match circuit_by_name.get(target) {
                    Some(target_circuit) => {
                        let mut pins: BTreeSet<String> = BTreeSet::new();
                        for pc in &target_circuit.components {
                            if pc.type_ == "wiring.pin" && !pc.name.is_empty() {
                                pins.insert(pc.name.clone());
                            }
                        }
                        // Subcircuits with no interface at all are legal
                        // (e.g. a circuit of only displays), so no error.
                        base.map(|_| pins)
                    }
                    None => {
                        errors.push(LoadError {
                            kind: LoadErrorKind::Other,
                            message: format!(
                                "component '{}': subcircuit references unknown circuit '{target}'",
                                comp.id
                            ),
                            circuit: cname.clone(),
                            comp_id: Some(CompId(idx as u32)),
                            wire_idx: None,
                        });
                        None
                    }
                },
                None => None, // attr error already recorded above
            }
        } else {
            components::validate_component(cname, idx, &comp.id, &comp.type_, &comp.attrs, errors)
                .map(|v| v.into_iter().map(|s| s.name).collect())
        };

        by_id.entry(comp.id.as_str()).or_insert(CompInfo { pins });
    }

    // Pass 2: wires.
    for (widx, wire) in circuit.wires.iter().enumerate() {
        let mut pin_endpoints = 0;
        for (label, endpoint) in [("a", &wire.a), ("b", &wire.b)] {
            if let Some((comp_id, pin)) = endpoint.as_pin() {
                pin_endpoints += 1;
                match by_id.get(comp_id) {
                    None => errors.push(LoadError {
                        kind: LoadErrorKind::UnresolvedPin,
                        message: format!(
                            "wire {widx} endpoint '{label}' references unknown component '{comp_id}'"
                        ),
                        circuit: cname.clone(),
                        comp_id: None,
                        wire_idx: Some(WireIdx(widx as u32)),
                    }),
                    Some(CompInfo { pins: None }) => { /* unknowable pins: skip */ }
                    Some(CompInfo { pins: Some(pins) }) => {
                        if !pins.contains(pin) {
                            errors.push(LoadError {
                                kind: LoadErrorKind::UnresolvedPin,
                                message: format!(
                                    "wire {widx} endpoint '{label}': component '{comp_id}' has no pin '{pin}'"
                                ),
                                circuit: cname.clone(),
                                comp_id: None,
                                wire_idx: Some(WireIdx(widx as u32)),
                            });
                        }
                    }
                }
            } else if let Some(join) = endpoint.as_join() {
                let target = join.wire as usize;
                if target >= circuit.wires.len() {
                    errors.push(LoadError {
                        kind: LoadErrorKind::UnresolvedJoin,
                        message: format!(
                            "wire {widx} endpoint '{label}' joins wire {}, which does not exist",
                            join.wire
                        ),
                        circuit: cname.clone(),
                        comp_id: None,
                        wire_idx: Some(WireIdx(widx as u32)),
                    });
                } else if target == widx {
                    errors.push(LoadError {
                        kind: LoadErrorKind::UnresolvedJoin,
                        message: format!("wire {widx} endpoint '{label}' joins itself"),
                        circuit: cname.clone(),
                        comp_id: None,
                        wire_idx: Some(WireIdx(widx as u32)),
                    });
                } else if join.segment >= circuit.wires[target].segment_count() {
                    errors.push(LoadError {
                        kind: LoadErrorKind::UnresolvedJoin,
                        message: format!(
                            "wire {widx} endpoint '{label}' joins segment {} of wire {}, which has {} segment(s)",
                            join.segment,
                            join.wire,
                            circuit.wires[target].segment_count()
                        ),
                        circuit: cname.clone(),
                        comp_id: None,
                        wire_idx: Some(WireIdx(widx as u32)),
                    });
                }
            }
        }
        if pin_endpoints == 0 {
            errors.push(LoadError {
                kind: LoadErrorKind::UnresolvedJoin,
                message: format!(
                    "wire {widx} has no pin endpoint (at least one endpoint must be a pin)"
                ),
                circuit: cname.clone(),
                comp_id: None,
                wire_idx: Some(WireIdx(widx as u32)),
            });
        }
    }
}

/// Subcircuit hierarchy must be acyclic and within the depth cap (§5.2,
/// §11). Three-color iterative DFS over the instantiation graph.
fn check_hierarchy(doc: &Document, errors: &mut Vec<LoadError>) {
    let mut idx_by_name: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, c) in doc.circuits.iter().enumerate() {
        idx_by_name.entry(c.name.as_str()).or_insert(i);
    }

    // Instantiation edges: circuit -> circuits it instantiates.
    let mut edges: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); doc.circuits.len()];
    for (i, c) in doc.circuits.iter().enumerate() {
        for comp in &c.components {
            if comp.type_ == "subcircuit" {
                if let Some(target) = comp.attrs.get("circuit").and_then(|v| v.as_str()) {
                    if let Some(&t) = idx_by_name.get(target) {
                        edges[i].insert(t);
                    }
                }
            }
        }
    }

    const WHITE: u8 = 0; // unvisited
    const GRAY: u8 = 1; // on the current path
    const BLACK: u8 = 2; // fully explored
    let mut color = vec![WHITE; doc.circuits.len()];
    let mut depth_reported = false;

    for start in 0..doc.circuits.len() {
        if color[start] != WHITE {
            continue;
        }
        // Iterative DFS with an explicit stack of (node, child iterator).
        let mut path: Vec<usize> = vec![start];
        let mut stack: Vec<std::collections::btree_set::Iter<'_, usize>> =
            vec![edges[start].iter()];
        color[start] = GRAY;
        while let Some(children) = stack.last_mut() {
            match children.next() {
                Some(&v) => {
                    if color[v] == GRAY {
                        let cycle_start = path.iter().position(|&u| u == v).unwrap_or(0);
                        let mut names: Vec<&str> = path[cycle_start..]
                            .iter()
                            .map(|&u| doc.circuits[u].name.as_str())
                            .collect();
                        names.push(doc.circuits[v].name.as_str());
                        err(
                            errors,
                            LoadErrorKind::HierarchyCycle,
                            &doc.circuits[v].name,
                            format!("subcircuit instantiation cycle: {}", names.join(" -> ")),
                        );
                    } else if color[v] == WHITE {
                        if path.len() >= MAX_HIERARCHY_DEPTH && !depth_reported {
                            depth_reported = true;
                            err(
                                errors,
                                LoadErrorKind::Other,
                                &doc.circuits[v].name,
                                format!(
                                    "subcircuit nesting exceeds the depth cap of {MAX_HIERARCHY_DEPTH}"
                                ),
                            );
                            continue;
                        }
                        if path.len() < MAX_HIERARCHY_DEPTH {
                            color[v] = GRAY;
                            path.push(v);
                            stack.push(edges[v].iter());
                        }
                    }
                }
                None => {
                    let u = path.pop().expect("path nonempty while stack is");
                    stack.pop();
                    color[u] = BLACK;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse + validate; returns the error list (may be empty).
    fn check(json: &str) -> Vec<LoadError> {
        match super::super::load_document(json.as_bytes()) {
            Ok(_) => Vec::new(),
            Err(e) => e,
        }
    }

    fn header(circuits: &str) -> String {
        format!(
            r#"{{"format":"circuitsim-plus-plus","version":3,"name":"t",
                "settings":{{"clockHz":1,"delayTable":"cs2200-74ls-v1"}},
                "circuits":[{circuits}]}}"#
        )
    }

    fn kinds(errors: &[LoadError]) -> Vec<LoadErrorKind> {
        errors.iter().map(|e| e.kind).collect()
    }

    const AND2: &str = r#"{
        "name":"and2",
        "components":[
            {"id":"c0","type":"wiring.pin","pos":[0,0],"name":"a"},
            {"id":"c1","type":"wiring.pin","pos":[0,2],"name":"b"},
            {"id":"c2","type":"wiring.pin","pos":[6,1],"name":"y","attrs":{"isOutput":true}},
            {"id":"c3","type":"gate.and","pos":[3,1]}
        ],
        "wires":[
            {"a":{"comp":"c0","pin":"pin"},"b":{"comp":"c3","pin":"in0"}},
            {"a":{"comp":"c1","pin":"pin"},"b":{"comp":"c3","pin":"in1"}},
            {"a":{"comp":"c3","pin":"out"},"b":{"comp":"c2","pin":"pin"}}
        ]
    }"#;

    #[test]
    fn minimal_valid_document() {
        let json = header(AND2);
        assert_eq!(check(&json), Vec::new());
    }

    #[test]
    fn unknown_delay_table_name_is_a_clean_error() {
        let json = header(AND2).replace("cs2200-74ls-v1", "cs2200-ecl-v9");
        let errors = check(&json);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].message.contains("cs2200-ecl-v9"), "{errors:?}");
        assert!(errors[0].message.contains("cs2200-74ls-v1"), "{errors:?}");
    }

    #[test]
    fn not_json_at_all() {
        let errors = check("this is not json");
        assert_eq!(kinds(&errors), vec![LoadErrorKind::Parse]);
    }

    #[test]
    fn missing_required_field() {
        let errors = check(r#"{"format":"circuitsim-plus-plus","version":2}"#);
        assert_eq!(kinds(&errors), vec![LoadErrorKind::Parse]);
    }

    #[test]
    fn wrong_format_string() {
        let json = header(AND2).replace("circuitsim-plus-plus", "circuitsim");
        let errors = check(&json);
        assert_eq!(kinds(&errors), vec![LoadErrorKind::Other]);
        assert!(errors[0].message.contains("unknown format"));
    }

    #[test]
    fn wrong_version() {
        let json = header(AND2).replace(r#""version":3"#, r#""version":4"#);
        let errors = check(&json);
        assert_eq!(kinds(&errors), vec![LoadErrorKind::Other]);
        assert!(errors[0].message.contains("version 4"));
    }

    #[test]
    fn duplicate_circuit_names() {
        let json = header(&format!("{AND2},{AND2}"));
        let errors = check(&json);
        assert_eq!(kinds(&errors), vec![LoadErrorKind::DuplicateName]);
        assert!(errors[0].message.contains("and2"));
    }

    #[test]
    fn duplicate_component_id() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"wiring.clock","pos":[0,0]},
            {"id":"c0","type":"wiring.clock","pos":[1,0]}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::DuplicateId]);
    }

    #[test]
    fn duplicate_component_name() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"mem.ram","pos":[0,0],"name":"imem"},
            {"id":"c1","type":"mem.ram","pos":[1,0],"name":"imem"}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::DuplicateName]);
    }

    #[test]
    fn unnamed_pin_component() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"wiring.pin","pos":[0,0]}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::Other]);
        assert!(errors[0].message.contains("must be named"));
    }

    #[test]
    fn unknown_component_type() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"gate.magic","pos":[0,0]}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::Other]);
        assert!(errors[0].message.contains("unknown component type"));
    }

    #[test]
    fn bad_attr_and_unknown_attr() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"gate.and","pos":[0,0],"attrs":{"inputs":"lots"}},
            {"id":"c1","type":"gate.and","pos":[1,0],"attrs":{"bitszize":8}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(
            kinds(&errors),
            vec![LoadErrorKind::Other, LoadErrorKind::Other]
        );
        assert!(errors[0].message.contains("unsigned integer"));
        assert!(errors[1].message.contains("unknown attr"));
        // comp_id is the document-order index within the circuit.
        assert_eq!(errors[0].comp_id, Some(CompId(0)));
        assert_eq!(errors[1].comp_id, Some(CompId(1)));
    }

    #[test]
    fn wire_to_unknown_component() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"wiring.clock","pos":[0,0]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c99","pin":"in"}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::UnresolvedPin]);
        assert_eq!(errors[0].wire_idx, Some(WireIdx(0)));
        assert!(errors[0].message.contains("c99"));
    }

    #[test]
    fn wire_to_unknown_pin() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"gate.and","pos":[0,0]},
            {"id":"c1","type":"wiring.probe","pos":[5,0]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"q"},"b":{"comp":"c1","pin":"in"}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::UnresolvedPin]);
        assert!(errors[0].message.contains("no pin 'q'"));
    }

    #[test]
    fn subcircuit_unknown_circuit() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"nope"}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::Other]);
        assert!(errors[0].message.contains("nope"));
    }

    #[test]
    fn subcircuit_unknown_pin() {
        let main = r#"{"name":"main","components":[
            {"id":"c0","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"and2"}},
            {"id":"c1","type":"wiring.probe","pos":[5,0]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"z"},"b":{"comp":"c1","pin":"in"}}
        ]}"#;
        let errors = check(&header(&format!("{AND2},{main}")));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::UnresolvedPin]);
        assert!(errors[0].message.contains("no pin 'z'"));
    }

    #[test]
    fn subcircuit_pin_resolution_ok() {
        let main = r#"{"name":"main","components":[
            {"id":"c0","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"and2"}},
            {"id":"c1","type":"wiring.probe","pos":[5,0]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"y"},"b":{"comp":"c1","pin":"in"}}
        ]}"#;
        assert_eq!(check(&header(&format!("{AND2},{main}"))), Vec::new());
    }

    #[test]
    fn join_to_missing_wire() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"wiring.clock","pos":[0,0]},
            {"id":"c1","type":"wiring.probe","pos":[5,0]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"out"},"b":{"join":{"wire":7,"segment":0}}},
            {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"in"}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::UnresolvedJoin]);
        assert!(errors[0].message.contains("does not exist"));
    }

    #[test]
    fn join_to_self() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"wiring.clock","pos":[0,0]},
            {"id":"c1","type":"wiring.probe","pos":[5,0]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"in"}},
            {"a":{"comp":"c0","pin":"out"},"b":{"join":{"wire":1,"segment":0}}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::UnresolvedJoin]);
        assert!(errors[0].message.contains("joins itself"));
    }

    #[test]
    fn join_segment_out_of_range() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"wiring.clock","pos":[0,0]},
            {"id":"c1","type":"wiring.probe","pos":[5,0]},
            {"id":"c2","type":"wiring.probe","pos":[5,2]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"in"},"points":[[1,0],[2,0],[3,0]]},
            {"a":{"comp":"c2","pin":"in"},"b":{"join":{"wire":0,"segment":2}}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::UnresolvedJoin]);
        assert!(errors[0].message.contains("segment 2"));
    }

    #[test]
    fn join_segment_ok() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"wiring.clock","pos":[0,0]},
            {"id":"c1","type":"wiring.probe","pos":[5,0]},
            {"id":"c2","type":"wiring.probe","pos":[5,2]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"in"},"points":[[1,0],[2,0],[3,0]]},
            {"a":{"comp":"c2","pin":"in"},"b":{"join":{"wire":0,"segment":1}}}
        ]}"#;
        assert_eq!(check(&header(circuit)), Vec::new());
    }

    #[test]
    fn wire_with_two_join_endpoints() {
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"wiring.clock","pos":[0,0]},
            {"id":"c1","type":"wiring.probe","pos":[5,0]},
            {"id":"c2","type":"wiring.probe","pos":[5,2]}
        ],"wires":[
            {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"in"}},
            {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c2","pin":"in"}},
            {"a":{"join":{"wire":0,"segment":0}},"b":{"join":{"wire":1,"segment":0}}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::UnresolvedJoin]);
        assert!(errors[0].message.contains("no pin endpoint"));
    }

    #[test]
    fn hierarchy_cycle_direct() {
        let a = r#"{"name":"a","components":[
            {"id":"c0","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"a"}}
        ]}"#;
        let errors = check(&header(a));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::HierarchyCycle]);
        assert!(errors[0].message.contains("a -> a"));
    }

    #[test]
    fn hierarchy_cycle_indirect() {
        let a = r#"{"name":"a","components":[
            {"id":"c0","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"b"}}
        ]}"#;
        let b = r#"{"name":"b","components":[
            {"id":"c0","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"a"}}
        ]}"#;
        let errors = check(&header(&format!("{a},{b}")));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::HierarchyCycle]);
        assert!(errors[0].message.contains("a -> b -> a"));
    }

    #[test]
    fn hierarchy_depth_cap() {
        // Chain: c0 instantiates c1, c1 instantiates c2, ...
        let n = super::MAX_HIERARCHY_DEPTH + 5;
        let mut circuits = Vec::new();
        for i in 0..n {
            circuits.push(format!(
                r#"{{"name":"c{i}","components":[{{"id":"s","type":"subcircuit","pos":[0,0],"attrs":{{"circuit":"c{}"}}}}]}}"#,
                i + 1
            ));
        }
        circuits.push(format!(r#"{{"name":"c{n}","components":[]}}"#));
        let errors = check(&header(&circuits.join(",")));
        assert_eq!(kinds(&errors), vec![LoadErrorKind::Other]);
        assert!(errors[0].message.contains("depth cap"));
    }

    #[test]
    fn many_errors_collected_at_once() {
        // Never partially load, never stop at the first error.
        let circuit = r#"{"name":"main","components":[
            {"id":"c0","type":"gate.and","pos":[0,0]},
            {"id":"c0","type":"wiring.clock","pos":[1,0]},
            {"id":"c1","type":"wiring.probe","pos":[2,0],"name":"p"},
            {"id":"c2","type":"wiring.probe","pos":[3,0],"name":"p"}
        ],"wires":[
            {"a":{"comp":"nope","pin":"out"},"b":{"comp":"c1","pin":"in"}},
            {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"bogus"}}
        ]}"#;
        let errors = check(&header(circuit));
        assert_eq!(
            kinds(&errors),
            vec![
                LoadErrorKind::DuplicateId,
                LoadErrorKind::DuplicateName,
                LoadErrorKind::UnresolvedPin,
                LoadErrorKind::UnresolvedPin,
            ]
        );
    }
}
