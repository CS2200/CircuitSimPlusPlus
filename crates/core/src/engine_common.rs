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

/// The component dependency edges (`drv → consumer`) that [`levelize`]
/// orders by: for every component, each *driver* of a net the component
/// consumes.
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
///
/// Shared with [`on_cycle`] so the acyclic order and the cycle analysis can
/// never disagree about what "feedback" means.
fn dep_edges(netlist: &Netlist, comps: &[Behavior]) -> Vec<Vec<u32>> {
    let n = netlist.comps.len();
    let mut edges: Vec<Vec<u32>> = vec![Vec::new(); n];
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
                edges[drv.0 as usize].push(ci as u32);
            }
        }
    }
    edges
}

/// Which components lie **on** a combinational feedback cycle (DESIGN.md
/// §4.5's SCC analysis) — i.e. are members of a strongly connected
/// component of size > 1, or feed themselves directly.
///
/// This is the precise subset of [`levelize`]'s residue that is *feedback*
/// rather than merely *downstream of* it. The delay engine reads it to
/// break a same-timestamp settle deterministically ([`crate::delay`]): only
/// a part that is genuinely in a loop gets CE's link-order tie-break, so a
/// combinational DAG — every design without feedback — is untouched.
pub(crate) fn on_cycle(netlist: &Netlist, comps: &[Behavior]) -> Vec<bool> {
    let edges = dep_edges(netlist, comps);
    let n = edges.len();
    // Kosaraju: finish order over the graph, then DFS the reverse graph in
    // reverse finish order. Each reverse tree is one SCC.
    let mut visited = vec![false; n];
    let mut order: Vec<u32> = Vec::with_capacity(n);
    for s in 0..n {
        if visited[s] {
            continue;
        }
        visited[s] = true;
        let mut stack: Vec<(usize, usize)> = vec![(s, 0)];
        while let Some(top) = stack.last_mut() {
            let v = top.0;
            if top.1 < edges[v].len() {
                let w = edges[v][top.1] as usize;
                top.1 += 1;
                if !visited[w] {
                    visited[w] = true;
                    stack.push((w, 0));
                }
            } else {
                order.push(v as u32);
                stack.pop();
            }
        }
    }
    let mut rev: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (v, outs) in edges.iter().enumerate() {
        for &w in outs {
            rev[w as usize].push(v as u32);
        }
    }
    let mut comp_of = vec![usize::MAX; n];
    let mut comp_size: Vec<usize> = Vec::new();
    for &s in order.iter().rev() {
        if comp_of[s as usize] != usize::MAX {
            continue;
        }
        let id = comp_size.len();
        let mut size = 0usize;
        let mut stack = vec![s];
        comp_of[s as usize] = id;
        while let Some(v) = stack.pop() {
            size += 1;
            for &w in &rev[v as usize] {
                if comp_of[w as usize] == usize::MAX {
                    comp_of[w as usize] = id;
                    stack.push(w);
                }
            }
        }
        comp_size.push(size);
    }
    (0..n)
        .map(|v| {
            comp_size[comp_of[v]] > 1 || edges[v].contains(&(v as u32)) // self-loop
        })
        .collect()
}

/// Levelize (Kahn) over the flattened netlist: DAG components in
/// evaluation order, then the residue (feedback + downstream) in
/// comp-index order. The dependency edges come from [`dep_edges`].
pub(crate) fn levelize(netlist: &Netlist, comps: &[Behavior]) -> (Vec<u32>, Vec<u32>) {
    let n = netlist.comps.len();
    let mut indeg = vec![0usize; n];
    let edges = dep_edges(netlist, comps);
    for outs in &edges {
        for &to in outs {
            indeg[to as usize] += 1;
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
    let drivers = &net_drivers[net.idx()];
    // Fast path: 0 or 1 non-excepted driver. A splitter reads its pins' nets this way on
    // every evaluation and most nets have a single driver, so allocating a `Vec` for that
    // case is pure overhead. Only a genuinely contended net needs the merge buffer.
    let mut first: Option<&Value> = None;
    for &(c, slot) in drivers {
        if c == except {
            continue;
        }
        let v = &drives[c as usize][slot];
        match first {
            None => first = Some(v),
            Some(_) => {
                let mut acc: Vec<Value> = Vec::with_capacity(drivers.len());
                for &(c2, slot2) in drivers {
                    if c2 != except {
                        acc.push(drives[c2 as usize][slot2].clone());
                    }
                }
                return Value::contention_merge(n.width, &acc);
            }
        }
    }
    match first {
        None => Value::z(n.width),
        Some(v) => v.clone(),
    }
}
