//! Shared scaffolding for the simulation engine (tasks B5/B6): behavior
//! construction, drive-slot layout, and net resolution. Extracted so the CLI,
//! the autograder and the interactive session can never disagree on these
//! basics (DESIGN.md §3: one engine, one set of semantics).

use serde::{Deserialize, Serialize};

use crate::api::{CompId, HaltReason, LoadError, LoadErrorKind, NetId};
use crate::behavior::Behavior;
use crate::components::PinDir;
use crate::netlist::Netlist;
use crate::value::Value;

/// A simulation stop with context (task B9 maps reasons to exit codes).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[error("cycle {cycle}: {reason:?}: {details}")]
pub struct Halt {
    /// Why the simulation stopped.
    pub reason: HaltReason,
    /// Cycle at which the halt occurred.
    pub cycle: u64,
    /// Human-readable context (e.g. the offending component and pin).
    pub details: String,
}

pub(crate) fn build_behaviors(netlist: &Netlist) -> Result<Vec<Behavior>, Vec<LoadError>> {
    let mut comps = Vec::with_capacity(netlist.comps.len());
    for fc in &netlist.comps {
        match crate::behavior::from_type_attrs(&fc.type_, &fc.attrs) {
            Some(b) => comps.push(b),
            None => {
                return Err(vec![LoadError {
                    kind: LoadErrorKind::Other,
                    message: format!(
                        "component '{}' has no behavior (type '{}')",
                        fc.origin(),
                        fc.type_
                    ),
                    circuit: fc.def_circuit.clone(),
                    comp_id: Some(CompId(fc.def_idx as u32)),
                    wire_idx: None,
                }]);
            }
        }
    }
    Ok(comps)
}

/// Drive slots, comp-major in `PinConn` order (one slot per pin; In-pin
/// slots are unused), initialized fully floating (Z).
pub(crate) fn drive_slots(netlist: &Netlist) -> Vec<Vec<Value>> {
    netlist
        .comps
        .iter()
        .map(|fc| fc.pins.iter().map(|p| Value::z(p.width)).collect())
        .collect()
}

/// Per net: (comp, pin slot) of each driver pin, in comp order.
pub(crate) fn net_drivers(netlist: &Netlist) -> Vec<Vec<(u32, usize)>> {
    netlist
        .nets
        .iter()
        .map(|n| {
            n.drivers
                .iter()
                .map(|(c, pin)| {
                    let slot = netlist.comps[c.idx()]
                        .pins
                        .iter()
                        .position(|p| &p.pin == pin)
                        .expect("driver pin exists");
                    (c.0, slot)
                })
                .collect()
        })
        .collect()
}

/// Resolve a net's current value by contention-merging its drivers' pin
/// slots (`Value::contention_merge`, DESIGN.md §4.1).
pub(crate) fn resolve(
    netlist: &Netlist,
    net_drivers: &[Vec<(u32, usize)>],
    drives: &[Vec<Value>],
    net: crate::api::NetId,
) -> Value {
    let n = &netlist.nets[net.idx()];
    let drivers = &net_drivers[net.idx()];
    match drivers.as_slice() {
        [] => Value::z(n.width),
        [(c, slot)] => drives[*c as usize][*slot].clone(),
        many => {
            let vals: Vec<Value> = many
                .iter()
                .map(|&(c, s)| drives[c as usize][s].clone())
                .collect();
            Value::contention_merge(n.width, &vals)
        }
    }
}

/// As [`resolve`], but skipping one component's contribution (splitters
/// read *other* drivers' contributions on their pins' nets).
pub(crate) fn resolve_except(
    netlist: &Netlist,
    net_drivers: &[Vec<(u32, usize)>],
    drives: &[Vec<Value>],
    net: crate::api::NetId,
    except: u32,
) -> Value {
    let n = &netlist.nets[net.idx()];
    let mut acc: Vec<Value> = Vec::new();
    for &(c, slot) in &net_drivers[net.idx()] {
        if c != except {
            acc.push(drives[c as usize][slot].clone());
        }
    }
    match acc.as_slice() {
        [] => Value::z(n.width),
        [v] => v.clone(),
        _ => Value::contention_merge(n.width, &acc),
    }
}
