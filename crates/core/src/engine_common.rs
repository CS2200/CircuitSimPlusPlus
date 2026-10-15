//! Shared scaffolding for the simulation engines (tasks B5/B6): behavior
//! construction, drive-slot layout, and net resolution. Extracted so the
//! zero-delay and delay-aware engines can never disagree on these basics
//! (DESIGN.md §3: behaviorally identical by construction).

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

/// Levelize (Kahn) over the flattened netlist: DAG components in
/// evaluation order, then the residue (feedback + downstream) in
/// comp-index order.
///
/// Dependency rule: comp B depends on every comp driving a net that B
/// consumes. Consumed pins come from `Behavior::comb_input_deps`
/// (register: none; RAM: `addr` only). Splitters consume every pin net
/// that has a driver other than themselves (their direction is dynamic;
/// static other-driver presence is the best DAG approximation — genuine
/// both-ways usage lands in the residue and iterates to fixpoint).
///
/// Self-loops force self-fed components into the residue — EXCEPT a
/// splitter's own driver listing (splitter pins are InOut, so a splitter
/// is always nominally a driver of its own nets; that pseudo-loop is not
/// feedback — its direction is resolved at evaluation, and treating it
/// as one wrongly seeded static splitter cones to 0, B11).
pub(crate) fn levelize(netlist: &Netlist, comps: &[Behavior]) -> (Vec<u32>, Vec<u32>) {
    let n = netlist.comps.len();
    let mut indeg = vec![0usize; n];
    let mut edges: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut add_edge = |from: u32, to: u32| {
        edges[from as usize].push(to);
        indeg[to as usize] += 1;
    };
    for (ci, beh) in comps.iter().enumerate() {
        let fc = &netlist.comps[ci];
        let consumed_nets: Vec<NetId> = if beh.is_splitter() {
            fc.pins
                .iter()
                .map(|p| p.net)
                .filter(|net| {
                    netlist.nets[net.idx()]
                        .drivers
                        .iter()
                        .any(|(drv, _)| drv.idx() != ci)
                })
                .collect()
        } else {
            let in_positions: Vec<usize> = fc
                .pins
                .iter()
                .enumerate()
                .filter(|(_, p)| p.dir == PinDir::In)
                .map(|(i, _)| i)
                .collect();
            beh.comb_input_deps(in_positions.len())
                .into_iter()
                .map(|dep| fc.pins[in_positions[dep]].net)
                .collect()
        };
        let splitter = beh.is_splitter();
        for net in consumed_nets {
            for (drv, _) in &netlist.nets[net.idx()].drivers {
                // A splitter's pins are InOut, so it is always listed as a
                // driver of its own nets — a *pseudo* self-loop that is
                // not feedback (its drive direction is dynamic, resolved
                // at evaluation). Real self-loops (a gate feeding itself)
                // still force the residue.
                if splitter && drv.idx() == ci {
                    continue;
                }
                add_edge(drv.0, ci as u32);
            }
        }
    }
    // Kahn, seeded and processed deterministically.
    let mut queue: std::collections::VecDeque<u32> =
        (0..n as u32).filter(|&i| indeg[i as usize] == 0).collect();
    let mut order = Vec::with_capacity(n);
    let mut scheduled = vec![false; n];
    while let Some(c) = queue.pop_front() {
        if scheduled[c as usize] {
            continue; // duplicate queue entries from multi-edge frees
        }
        scheduled[c as usize] = true;
        order.push(c);
        for &next in &edges[c as usize] {
            indeg[next as usize] -= 1;
            if indeg[next as usize] == 0 {
                queue.push_back(next);
            }
        }
    }
    let residue: Vec<u32> = (0..n as u32).filter(|&i| !scheduled[i as usize]).collect();
    (order, residue)
}

/// Construct a behavior per flattened component. Errors only if a
/// component has no behavior — impossible for a validated document
/// (subcircuits are inlined; unknown types are rejected at load).
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
