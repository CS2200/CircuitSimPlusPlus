//! # csim-core
//!
//! Simulation engine core for CircuitSim++. The normative specification is
//! `DESIGN.md` at the repository root; the execution plan is `docs/tasks/BACKEND.md`.
//!
//! ## Determinism rules (DESIGN.md §4.6 — binding on all contributors)
//!
//! Evaluation, serialization, and output paths in this crate must be
//! bit-for-bit reproducible across runs and platforms:
//!
//! - No `HashMap`/`HashSet` iteration order may affect anything observable.
//!   Use index-ordered `Vec`, `BTreeMap`, or `indexmap::IndexMap` instead.
//! - No floating point, no wall-clock, no RNG in the evaluation path.
//!
//! Same file + same mode + same inputs ⇒ identical trace, everywhere.

pub mod api;
pub mod behavior;
pub mod components;
pub mod format;
pub mod ids;
pub mod netlist;
pub mod value;
pub mod zero;
