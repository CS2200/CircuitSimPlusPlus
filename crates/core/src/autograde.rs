//! Autograder core (DESIGN.md §8.2, §8.3; BACKEND.md task B9).
//!
//! JSON-in/JSON-out contract for the headless `csim` CLI (task B10):
//! load → preload memories → run under limits → evaluate assertions →
//! structured report + exit code. Determinism (§4.6): every
//! simulation-derived field (`cycles`, `t_obs`, `est_time`, paths,
//! `trace_hash`, assertion results) is identical for identical inputs on
//! any grader instance; only resource telemetry (`wall_time_ms`,
//! `peak_rss_bytes`) varies by machine.
//!
//! ## Exit-code taxonomy (§8.2)
//!
//! | code | meaning |
//! |------|---------|
//! | 0 | all assertions passed |
//! | 1 | assertion failure (also: contention/other abnormal halts) |
//! | 2 | cycle limit: run consumed its budget while `expect_halt` was set |
//! | 3 | timeout / RSS guard tripped |
//! | 4 | oscillation halt |
//! | 5 | floating-read halt |
//! | 6 | malformed file (load/validation/preload errors) |
//!
//! Precedence: 6 → engine halt (4/5/1) → 3 → 2 → 1 → 0. A run that
//! consumes its cycle budget *without* a halt is **normal** for this
//! course's model (run N cycles, then check state) — it proceeds to
//! assertion evaluation; exit 2 is only for specs that explicitly
//! declare `expect_halt` (the design was supposed to stop on its own).
//!
//! ## Assertion language
//!
//! ```text
//! probe('result') == 0x2A          — named probe/register value
//! mem('dmem')[0x100] == 0x1234     — named RAM/ROM word
//! violations == 0                  — setup/hold warning count
//! ```
//!
//! Operators: `== != < <= > >=`. Literals: `0x…` hex, `0b…` binary,
//! decimal. A compared value containing `X`/`Z` bits never equals a
//! literal — the assertion fails with the masks shown (§4.1's X-is-not-
//! a-number semantics).

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::api::{self, CompId, HaltReason, LoadError, NamedKind};
use crate::delay::{DelayEngine, Halt, RunReport};
use crate::format::Document;
use crate::netlist::{self, Netlist};
use crate::sta;
use crate::timing_table::TimingTable;
use crate::value::Value;

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/// Exit 0 — all assertions passed.
pub const EXIT_OK: i32 = 0;
/// Exit 1 — assertion failure (also contention/other abnormal halts).
pub const EXIT_ASSERTION_FAILED: i32 = 1;
/// Exit 2 — cycle budget consumed while `expect_halt` was set.
pub const EXIT_CYCLE_LIMIT: i32 = 2;
/// Exit 3 — timeout / RSS guard tripped.
pub const EXIT_TIMEOUT: i32 = 3;
/// Exit 4 — oscillation halt.
pub const EXIT_OSCILLATION: i32 = 4;
/// Exit 5 — floating-read halt.
pub const EXIT_FLOATING_READ: i32 = 5;
/// Exit 6 — malformed file (load/validation/preload errors).
pub const EXIT_MALFORMED_FILE: i32 = 6;

/// Grading outcome → exit code (table in module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GradeOutcome {
    /// All assertions passed (exit 0).
    Passed,
    /// An assertion evaluated false (exit 1).
    AssertionFailed,
    /// Budget consumed without a natural halt while `expect_halt` was set
    /// (exit 2).
    CycleLimit,
    /// Timeout / RSS guard tripped (exit 3).
    Timeout,
    /// Oscillation halt (exit 4).
    Oscillation,
    /// Floating-read halt (exit 5).
    FloatingRead,
    /// Load/validation/preload errors (exit 6).
    MalformedFile,
    /// Contention or another abnormal halt not in the taxonomy.
    OtherHalt,
}

impl GradeOutcome {
    /// Map to the process exit code (table in module docs).
    pub fn exit_code(self) -> i32 {
        match self {
            GradeOutcome::Passed => EXIT_OK,
            GradeOutcome::AssertionFailed | GradeOutcome::OtherHalt => EXIT_ASSERTION_FAILED,
            GradeOutcome::CycleLimit => EXIT_CYCLE_LIMIT,
            GradeOutcome::Timeout => EXIT_TIMEOUT,
            GradeOutcome::Oscillation => EXIT_OSCILLATION,
            GradeOutcome::FloatingRead => EXIT_FLOATING_READ,
            GradeOutcome::MalformedFile => EXIT_MALFORMED_FILE,
        }
    }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/// Comparison operators (full set — TA decision).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CmpOp {
    /// `==`
    Eq,
    /// `!=`
    Ne,
    /// `<`
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
}

impl CmpOp {
    fn apply(self, a: u64, b: u64) -> bool {
        match self {
            CmpOp::Eq => a == b,
            CmpOp::Ne => a != b,
            CmpOp::Lt => a < b,
            CmpOp::Le => a <= b,
            CmpOp::Gt => a > b,
            CmpOp::Ge => a >= b,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            CmpOp::Eq => "==",
            CmpOp::Ne => "!=",
            CmpOp::Lt => "<",
            CmpOp::Le => "<=",
            CmpOp::Gt => ">",
            CmpOp::Ge => ">=",
        }
    }
}

/// A parsed assertion (see module docs for the grammar).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assertion {
    /// `probe('<name>') <op> <value>` — named probe/register value.
    Probe {
        /// Name of the probe or register.
        name: String,
        /// Comparison operator.
        op: CmpOp,
        /// Literal to compare against.
        value: u64,
    },
    /// `mem('<name>')[<addr>] <op> <value>` — named RAM/ROM word.
    Mem {
        /// Name of the RAM or ROM.
        name: String,
        /// Word address.
        addr: u64,
        /// Comparison operator.
        op: CmpOp,
        /// Literal to compare against.
        value: u64,
    },
    /// `violations <op> <value>` — setup/hold warning count.
    Violations {
        /// Comparison operator.
        op: CmpOp,
        /// Literal to compare against.
        value: u64,
    },
}

/// Assertion parse failure (position-free — assertions are one-liners).
#[derive(Debug, Error, PartialEq, Eq)]
#[error("malformed assertion '{0}': expected probe('<name>') <op> <value>, mem('<name>')[<addr>] <op> <value>, or violations <op> <value>")]
pub struct AssertError(String);

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn keyword(&mut self, kw: &str) -> bool {
        self.ws();
        if self.s[self.i..].starts_with(kw.as_bytes()) {
            self.i += kw.len();
            true
        } else {
            false
        }
    }

    fn ch(&mut self, c: u8) -> bool {
        self.ws();
        if self.i < self.s.len() && self.s[self.i] == c {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn quoted(&mut self) -> Result<String, ()> {
        if !self.ch(b'\'') {
            return Err(());
        }
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i] != b'\'' {
            self.i += 1;
        }
        if self.i >= self.s.len() {
            return Err(());
        }
        let out = std::str::from_utf8(&self.s[start..self.i])
            .map(str::to_string)
            .map_err(|_| ())?;
        self.i += 1;
        Ok(out)
    }

    fn number(&mut self) -> Result<u64, ()> {
        self.ws();
        let rest = &self.s[self.i..];
        let radix = if rest.starts_with(b"0x") || rest.starts_with(b"0X") {
            self.i += 2;
            16
        } else if rest.starts_with(b"0b") || rest.starts_with(b"0B") {
            self.i += 2;
            2
        } else {
            10
        };
        let start = self.i;
        while self.i < self.s.len() && (self.s[self.i] as char).is_digit(radix) {
            self.i += 1;
        }
        if self.i == start {
            return Err(());
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).map_err(|_| ())?;
        u64::from_str_radix(text, radix).map_err(|_| ())
    }

    fn op(&mut self) -> Result<CmpOp, ()> {
        self.ws();
        for (tok, op) in [
            ("==", CmpOp::Eq),
            ("!=", CmpOp::Ne),
            ("<=", CmpOp::Le),
            (">=", CmpOp::Ge),
            ("<", CmpOp::Lt),
            (">", CmpOp::Gt),
        ] {
            if self.s[self.i..].starts_with(tok.as_bytes()) {
                self.i += tok.len();
                return Ok(op);
            }
        }
        Err(())
    }

    fn done(&mut self) -> bool {
        self.ws();
        self.i == self.s.len()
    }
}

/// Parse one assertion string (grammar in module docs).
pub fn parse_assertion(text: &str) -> Result<Assertion, AssertError> {
    let err = || AssertError(text.to_string());
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    let out = if p.keyword("probe") {
        if !p.ch(b'(') {
            return Err(err());
        }
        let name = p.quoted().map_err(|_| err())?;
        if !p.ch(b')') {
            return Err(err());
        }
        Assertion::Probe {
            name,
            op: p.op().map_err(|_| err())?,
            value: p.number().map_err(|_| err())?,
        }
    } else if p.keyword("mem") {
        if !p.ch(b'(') {
            return Err(err());
        }
        let name = p.quoted().map_err(|_| err())?;
        if !p.ch(b')') || !p.ch(b'[') {
            return Err(err());
        }
        let addr = p.number().map_err(|_| err())?;
        if !p.ch(b']') {
            return Err(err());
        }
        Assertion::Mem {
            name,
            addr,
            op: p.op().map_err(|_| err())?,
            value: p.number().map_err(|_| err())?,
        }
    } else if p.keyword("violations") {
        Assertion::Violations {
            op: p.op().map_err(|_| err())?,
            value: p.number().map_err(|_| err())?,
        }
    } else {
        return Err(err());
    };
    if !p.done() {
        return Err(err());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Configuration: run limits, preloads, test spec
// ---------------------------------------------------------------------------

/// Caps on a grading run (§11). `None` = uncapped.
#[derive(Debug, Clone, Default)]
pub struct RunLimits {
    /// Cycle budget for the run.
    pub max_cycles: u64,
    /// Wall-clock deadline.
    pub timeout: Option<Duration>,
    /// Peak-RSS guard, in bytes.
    pub rss_cap_bytes: Option<u64>,
}

/// One memory preload (`--load name=file`, §8.1).
#[derive(Debug, Clone)]
pub enum LoadSource {
    /// Already-parsed words (tests, embedded contents).
    Words(Vec<u64>),
    /// An `rle-hex-v1` image file (§8.1, Appendix A); resolved against
    /// the memory's depth at apply time.
    File(std::path::PathBuf),
}

/// A testbench poke (§8.3 setup): drive a named input pin. Delay mode
/// schedules it at time `at` (ns); zero mode applies it before the run.
#[derive(Debug, Clone)]
pub struct Poke {
    /// Name of the `wiring.pin` input to drive.
    pub target: String,
    /// Value to drive.
    pub value: u64,
    /// Time (ns) to drive at.
    pub at: u64,
}

/// Everything a grading run needs that isn't the circuit file.
#[derive(Debug, Clone)]
pub struct GradeConfig {
    /// Run caps (§11).
    pub limits: RunLimits,
    /// Assertions to evaluate after the run (grammar in module docs).
    pub assertions: Vec<Assertion>,
    /// Memory preloads: `(name, source)` pairs (`--load name=file`, §8.1).
    pub loads: Vec<(String, LoadSource)>,
    /// Testbench pokes (§8.3 setup).
    pub pokes: Vec<Poke>,
    /// Global clock half-period in ns (delay mode; §8.3 clock config).
    /// Runtime is event-count-driven, so this only affects violation and
    /// DTA semantics, never speed.
    pub clock_half_period: u64,
    /// Course baseline processor's `est_time` for `speedup_vs_baseline`.
    pub baseline_est_time: Option<u64>,
    /// Exit 2 when the budget is consumed without a natural halt
    /// (module docs).
    pub expect_halt: bool,
    /// Top-k observed critical paths in the report.
    pub top_k: usize,
    /// Include informational STA (`t_sta`, §4.4 — clearly labeled).
    pub include_sta: bool,
    /// §8.3 rubric hook: full credit when `est_time` is below this.
    pub rubric_full_credit_below: Option<u64>,
}

impl Default for GradeConfig {
    fn default() -> Self {
        GradeConfig {
            limits: RunLimits::default(),
            assertions: Vec::new(),
            loads: Vec::new(),
            pokes: Vec::new(),
            clock_half_period: 1000,
            baseline_est_time: None,
            expect_halt: false,
            top_k: 10,
            include_sta: false,
            rubric_full_credit_below: None,
        }
    }
}

/// JSON test-spec file (§8.3, TA decision: JSON): replaces long flag
/// lists. All fields optional; absent = GradeConfig defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct TestSpec {
    /// Cycle budget → `RunLimits::max_cycles`.
    pub cycles: Option<u64>,
    /// Wall-clock timeout, in milliseconds.
    pub timeout_ms: Option<u64>,
    /// RSS guard, in bytes.
    pub rss_cap_bytes: Option<u64>,
    /// Course baseline processor's `est_time` for `speedup_vs_baseline`.
    pub baseline_est_time: Option<u64>,
    /// Require a natural halt within the cycle budget (exit 2 otherwise).
    pub expect_halt: Option<bool>,
    /// Top-k observed critical paths in the report.
    pub top_paths: Option<usize>,
    /// Include informational STA (`t_sta`, §4.4 — clearly labeled).
    pub include_sta: Option<bool>,
    /// §8.3 rubric hook: full credit when `est_time` is below this.
    pub rubric_full_credit_below: Option<u64>,
    /// Memory preloads.
    pub loads: Vec<SpecLoad>,
    /// Testbench pokes.
    pub pokes: Vec<SpecPoke>,
    /// Global clock half-period in ns (delay mode).
    pub clock_half_period_ns: Option<u64>,
    /// Assertion strings (grammar in module docs).
    pub assertions: Vec<String>,
}

/// One spec-file memory preload (a `loads` entry).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecLoad {
    /// Name of the target memory.
    pub memory: String,
    /// rle-hex-v1 image, resolved relative to the spec file (§11).
    pub file: String,
}

/// One spec-file poke (a `pokes` entry).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecPoke {
    /// Name of the `wiring.pin` input to drive.
    pub target: String,
    /// Literal value (`0x…`/`0b…`/decimal, same syntax as assertions).
    pub value: String,
    /// Drive at this time (ns).
    #[serde(default)]
    pub at: u64,
}

impl TestSpec {
    /// Parse a spec file from raw JSON bytes.
    pub fn from_json(bytes: &[u8]) -> Result<TestSpec, String> {
        serde_json::from_slice(bytes).map_err(|e| format!("test spec: {e}"))
    }

    /// Resolve into a [`GradeConfig`]; spec file's directory roots the
    /// relative load paths (§11 sandboxing is the CLI's enforcement, B10).
    pub fn into_config(self, spec_dir: &std::path::Path) -> Result<GradeConfig, String> {
        let mut cfg = GradeConfig::default();
        if let Some(c) = self.cycles {
            cfg.limits.max_cycles = c;
        }
        cfg.limits.timeout = self.timeout_ms.map(Duration::from_millis);
        cfg.limits.rss_cap_bytes = self.rss_cap_bytes;
        cfg.baseline_est_time = self.baseline_est_time;
        cfg.expect_halt = self.expect_halt.unwrap_or(false);
        cfg.top_k = self.top_paths.unwrap_or(10);
        cfg.include_sta = self.include_sta.unwrap_or(false);
        cfg.rubric_full_credit_below = self.rubric_full_credit_below;
        for l in &self.loads {
            cfg.loads
                .push((l.memory.clone(), LoadSource::File(spec_dir.join(&l.file))));
        }
        for p in &self.pokes {
            let value = Parser {
                s: p.value.as_bytes(),
                i: 0,
            }
            .number()
            .map_err(|_| format!("poke '{}': bad value '{}'", p.target, p.value))?;
            cfg.pokes.push(Poke {
                target: p.target.clone(),
                value,
                at: p.at,
            });
        }
        if let Some(h) = self.clock_half_period_ns {
            cfg.clock_half_period = h;
        }
        for a in &self.assertions {
            cfg.assertions
                .push(parse_assertion(a).map_err(|e| e.to_string())?);
        }
        Ok(cfg)
    }
}

// ---------------------------------------------------------------------------
// Report (§8.2 — all fields; contract v1.1 shapes)
// ---------------------------------------------------------------------------

/// Per-assertion outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssertionResult {
    /// Canonical rendering of the assertion (e.g. `probe('result') == 0x2A`).
    pub assertion: String,
    /// Whether the assertion held.
    pub passed: bool,
    /// Rendered observed value (hex, or X/Z masks).
    pub actual: String,
    /// Rendered expected comparison (`== 0x2A`).
    pub expected: String,
}

/// The JSON report (§8.2). Simulation-derived fields are bit-identical
/// across runs/machines; `wall_time_ms`/`peak_rss_bytes` are telemetry.
///
/// Contract v1.1: `timing_violations` is the setup/hold warning **count**
/// (DESIGN §8.2's name); the warnings themselves are in
/// `violation_details`, and `top_paths` uses the document-identity
/// [`api::TimingPath`] shape. `errors` carries the load/validation error list
/// when `halt_reason` is `"malformed-file"` (empty otherwise) — one
/// malformed-file JSON shape everywhere (F10).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    /// Cycles executed.
    pub cycles: u64,
    /// "completed" | "cycle-limit" | "oscillation" | "floating-read" |
    /// "contention" | "error" | "timeout" | "resource-limit" |
    /// "malformed-file" (+ detail in `halt_details`).
    pub halt_reason: String,
    /// Names the component/pin involved in the halt, when any
    /// (`comp <id> pin "<pin>": …` prefix, contract v1.1).
    pub halt_details: String,
    /// Max observed per-cycle settle time, delay-table units (ns); 0 in
    /// zero mode.
    pub t_obs: u64,
    /// `cycles × t_obs` (saturating); 0 in zero mode.
    pub est_time: u64,
    /// `baseline_est_time / est_time`; `None` without a baseline or when
    /// `est_time == 0`.
    pub speedup_vs_baseline: Option<f64>,
    /// Number of setup/hold warnings (§8.2; `violation_details.len()`).
    pub timing_violations: u64,
    /// The setup/hold warnings themselves, with document-identity
    /// component references (contract v1.1).
    pub violation_details: Vec<api::TimingViolation>,
    /// Per-assertion outcomes.
    pub assertions: Vec<AssertionResult>,
    /// Top-k observed critical paths (§4.4), grouped per circuit with
    /// document-order component indices (contract v1.1).
    pub top_paths: Vec<api::TimingPath>,
    /// Informational structural bound (§4.4) — may include paths the
    /// design never sensitizes; STA totals INCLUDE the destination
    /// register's setup time (docs/delay-table.md). `None` when not
    /// requested or when STA failed (see `sta_note`).
    pub t_sta: Option<u64>,
    /// Labeling/provenance note for `t_sta` (§4.4), or the STA error.
    pub sta_note: Option<String>,
    /// DRAFT-table provenance (`cs2200-74ls-v1 (DRAFT)`).
    pub delay_table: String,
    /// Determinism hash of the event trace (§4.6); delay mode only.
    pub trace_hash: Option<u64>,
    /// §8.3 rubric hook; `None` when no threshold was given.
    pub rubric_full_credit: Option<bool>,
    /// Load/validation errors when `halt_reason` is `"malformed-file"`;
    /// empty on success (F10).
    pub errors: Vec<LoadError>,
    /// Peak resident set, in bytes (telemetry — varies by machine).
    pub peak_rss_bytes: Option<u64>,
    /// Wall-clock duration of the run (telemetry — varies by machine).
    pub wall_time_ms: u64,
}

/// Map an engine violation to the contract shape (document identity).
pub(crate) fn api_violation(
    nl: &Netlist,
    v: &crate::delay::TimingViolation,
) -> api::TimingViolation {
    let (circuit, comp_id) = nl.doc_id(v.comp);
    let origin = nl.comps[v.comp.idx()].origin();
    api::TimingViolation {
        circuit,
        comp_id,
        kind: match v.kind {
            crate::delay::ViolationKind::Setup => api::ViolationKind::Setup,
            crate::delay::ViolationKind::Hold => api::ViolationKind::Hold,
        },
        detail: format!(
            "{:?} violation at {origin}: input changed at T={} ns (cycle {})",
            v.kind, v.time, v.cycle
        ),
    }
}

/// Map a flat (engine) observed path to contract [`TimingPath`]s: split
/// into consecutive runs by defining circuit, one entry per run,
/// preserving order (contract v1.1's "group/attribute per circuit").
pub(crate) fn api_path(nl: &Netlist, settle: u64, path: &[CompId]) -> Vec<api::TimingPath> {
    let mut out: Vec<api::TimingPath> = Vec::new();
    for &c in path {
        let (circuit, comp_id) = nl.doc_id(c);
        match out.last_mut() {
            Some(last) if last.circuit == circuit => last.comps.push(comp_id),
            _ => out.push(api::TimingPath {
                circuit,
                comps: vec![comp_id],
                delay_ns: settle,
            }),
        }
    }
    out
}

/// What came back from a grading run.
#[derive(Debug, Clone)]
pub struct GradeOutput {
    /// The JSON report (§8.2).
    pub report: Report,
    /// Grading outcome — drives the CLI exit code.
    pub outcome: GradeOutcome,
}

/// Configuration problem discovered before the run (unknown assertion
/// target, unloadable memory image, …). The CLI maps this to a usage
/// error — not one of the six grading codes.
#[derive(Debug, Error)]
#[error("grader configuration: {0}")]
pub struct ConfigError(pub String);

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/// Cycles per engine call between limit checks (timeout/RSS granularity).
const RUN_CHUNK: u64 = 2048;

/// Render an observed 4-state value for an assertion result.
fn render_actual(v: &Value) -> String {
    if v.is_fully_known() {
        match v.to_u64() {
            Some(n) => format!("0x{n:X}"),
            None => "0x?".to_string(),
        }
    } else {
        let wv = v.to_wire_value();
        format!("v=0x{} x=0x{} z=0x{} (X/Z present)", wv.v, wv.x, wv.z)
    }
}

fn numeric(v: &Value) -> Option<u64> {
    if v.is_fully_known() {
        v.to_u64()
    } else {
        None
    }
}

/// Peak resident set, Linux `/proc` (the CLI targets musl; §11 RSS guard).
#[cfg(target_os = "linux")]
fn peak_rss_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let kb: u64 = rest.trim().strip_suffix("kB")?.trim().parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn peak_rss_bytes() -> Option<u64> {
    None
}

/// Engine-build or preload failure → malformed-file report.
fn malformed(errors: Vec<LoadError>, table_name: &str, started: Instant) -> GradeOutput {
    (GradeOutcome::MalformedFile, errors, table_name, started).into()
}

/// The one malformed-file report shape (contract v1.1, F10) — public so
/// the CLI emits the identical JSON for errors it discovers before the
/// runner starts (parse/validation failures). `delay_table` is best-
/// effort (`"unknown"` when the document didn't parse far enough).
pub fn malformed_report(errors: Vec<LoadError>, delay_table: &str) -> Report {
    malformed(errors, delay_table, Instant::now()).report
}

impl From<(GradeOutcome, Vec<LoadError>, &str, Instant)> for GradeOutput {
    fn from(
        (outcome, errors, table_name, started): (GradeOutcome, Vec<LoadError>, &str, Instant),
    ) -> Self {
        GradeOutput {
            report: Report {
                cycles: 0,
                halt_reason: "malformed-file".to_string(),
                halt_details: String::new(),
                t_obs: 0,
                est_time: 0,
                speedup_vs_baseline: None,
                timing_violations: 0,
                violation_details: Vec::new(),
                assertions: Vec::new(),
                top_paths: Vec::new(),
                t_sta: None,
                sta_note: None,
                delay_table: table_name.to_string(),
                trace_hash: None,
                rubric_full_credit: None,
                errors,
                peak_rss_bytes: peak_rss_bytes(),
                wall_time_ms: started.elapsed().as_millis() as u64,
            },
            outcome,
        }
    }
}

/// Run the full grading flow (module docs). Never panics; never hangs
/// past `limits` (engine event-storm caps backstop pathological runs).
pub fn grade(doc: &Document, cfg: &GradeConfig) -> Result<GradeOutput, ConfigError> {
    let started = Instant::now();
    let table_name = doc.settings.delay_table.clone();

    // -- Build -----------------------------------------------------------
    let nl = match netlist::build(doc) {
        Ok(nl) => nl,
        Err(e) => return Ok(malformed(e, &table_name, started)),
    };
    let table =
        TimingTable::builtin(&doc.settings.delay_table).map_err(|e| ConfigError(e.to_string()))?; // validated at load — unreachable

    // -- Pre-validate assertion targets and loads (fast fail, B10 UX) ----
    let named_kind = |name: &str| {
        nl.named
            .iter()
            .find(|n| n.name == name)
            .map(|n| (n.kind, n.comp_id))
    };
    for a in &cfg.assertions {
        let (name, want_mem) = match a {
            Assertion::Probe { name, .. } => (name, false),
            Assertion::Mem { name, .. } => (name, true),
            Assertion::Violations { .. } => continue,
        };
        match named_kind(name) {
            Some((kind, _)) => {
                let ok = if want_mem {
                    matches!(kind, NamedKind::Ram | NamedKind::Rom)
                } else {
                    matches!(kind, NamedKind::Probe | NamedKind::Register)
                };
                if !ok {
                    return Err(ConfigError(format!(
                        "'{name}' is a {kind:?}, not a {}",
                        if want_mem { "memory" } else { "probe/register" }
                    )));
                }
            }
            None => {
                return Err(ConfigError(format!(
                    "no named component '{name}' (named: {})",
                    nl.named
                        .iter()
                        .map(|n| n.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
        }
    }

    // -- Engine (delay-aware only) ---------------------------------------
    let half = cfg.clock_half_period.max(1);
    let mut eng = match DelayEngine::new(nl, half, &table) {
        Ok(e) => e,
        Err(e) => return Ok(malformed(e, &table_name, started)),
    };
    grade_delay(&mut eng, cfg, &table, started)
}

/// Apply preloads; returns a ConfigError on unknown names / bad images.
fn apply_loads<E: MemAccess>(
    eng: &mut E,
    nl: &Netlist,
    cfg: &GradeConfig,
) -> Result<(), ConfigError> {
    for (name, source) in &cfg.loads {
        let words = match source {
            LoadSource::Words(w) => w.clone(),
            LoadSource::File(path) => {
                let bytes = std::fs::read_to_string(path)
                    .map_err(|e| ConfigError(format!("{}: {e}", path.display())))?;
                let depth = memory_depth(nl, name)
                    .ok_or_else(|| ConfigError(format!("no named memory '{name}'")))?;
                crate::format::rle::parse(&bytes, depth as usize)
                    .map_err(|e| ConfigError(format!("{}: {e}", path.display())))?
            }
        };
        match eng.load_memory_image(name, &words) {
            Ok(true) => {}
            // F1: image errors (e.g. a word wider than the memory's
            // bitsize) are clean configuration errors, never panics.
            Err(e) => return Err(ConfigError(format!("{name}: {e}"))),
            Ok(false) => return Err(ConfigError(format!("no named memory '{name}'"))),
        }
    }
    Ok(())
}

/// Effective depth of a named memory. Goes through the typed component
/// configuration so an omitted `depth` attr yields the documented
/// default (F4) rather than a spurious "no named memory".
pub(crate) fn memory_depth(nl: &Netlist, name: &str) -> Option<u64> {
    let ci = nl.named_engine_id(name)?;
    let fc = &nl.comps[ci.idx()];
    if !matches!(fc.type_.as_str(), "mem.ram" | "mem.rom") {
        return None;
    }
    match crate::components::config(&fc.type_, &fc.attrs)?.kind {
        crate::components::CompKind::Ram { depth, .. }
        | crate::components::CompKind::Rom { depth, .. } => Some(u64::from(depth)),
        _ => None,
    }
}

/// Poke targets are named `wiring.pin` *input* components (§8.3); they
/// are not in `named` (that registry is RAM/ROM/register/probe, §8.2).
fn input_pin_width(nl: &Netlist, name: &str) -> Option<u32> {
    nl.comps
        .iter()
        .find(|c| c.type_ == "wiring.pin" && c.name.as_deref() == Some(name))
        .and_then(|c| c.pins.first().map(|p| p.width))
}

/// Width-check a poke value (F5): a value wider than the target pin is a
/// clean error, never a panic.
fn poke_value(width: u32, p: &Poke) -> Result<Value, ConfigError> {
    if width < 64 && (p.value >> width) != 0 {
        return Err(ConfigError(format!(
            "poke '{}': value {:#x} does not fit in {} bits",
            p.target, p.value, width
        )));
    }
    Ok(Value::from_u64(width, p.value))
}

/// Delay-mode pokes are scheduled at absolute times before the run.
fn apply_pokes_delay(
    eng: &mut DelayEngine,
    nl: &Netlist,
    cfg: &GradeConfig,
) -> Result<(), ConfigError> {
    for p in &cfg.pokes {
        let width = input_pin_width(nl, &p.target).ok_or_else(|| {
            ConfigError(format!(
                "poke target '{}' is not a named input pin",
                p.target
            ))
        })?;
        let v = poke_value(width, p)?;
        if !eng.poke_at(&p.target, v, p.at) {
            return Err(ConfigError(format!(
                "poke target '{}' is not a named input pin",
                p.target
            )));
        }
    }
    Ok(())
}

/// The engine operations the grader shares across modes.
trait MemAccess {
    fn load_memory_image(&mut self, name: &str, image: &[u64]) -> Result<bool, String>;
}

impl MemAccess for DelayEngine {
    fn load_memory_image(&mut self, name: &str, image: &[u64]) -> Result<bool, String> {
        DelayEngine::load_memory_image(self, name, image)
    }
}

/// Map an engine halt to outcome + report strings.
fn halt_outcome(h: &Halt) -> (GradeOutcome, &'static str) {
    match h.reason {
        HaltReason::Oscillation => (GradeOutcome::Oscillation, "oscillation"),
        HaltReason::FloatingRead => (GradeOutcome::FloatingRead, "floating-read"),
        HaltReason::Contention => (GradeOutcome::OtherHalt, "contention"),
        HaltReason::CycleLimit => (GradeOutcome::CycleLimit, "cycle-limit"),
        _ => (GradeOutcome::OtherHalt, "error"),
    }
}

/// Limits check between run chunks. Returns the outcome on trip.
fn limits_tripped(
    cfg: &GradeConfig,
    deadline: Option<Instant>,
) -> Option<(GradeOutcome, &'static str)> {
    if let Some(d) = deadline {
        if Instant::now() > d {
            return Some((GradeOutcome::Timeout, "timeout"));
        }
    }
    if let Some(cap) = cfg.limits.rss_cap_bytes {
        if peak_rss_bytes().is_some_and(|rss| rss > cap) {
            return Some((GradeOutcome::Timeout, "resource-limit"));
        }
    }
    None
}

#[allow(clippy::too_many_lines)]
fn grade_delay(
    eng: &mut DelayEngine,
    cfg: &GradeConfig,
    table: &TimingTable,
    started: Instant,
) -> Result<GradeOutput, ConfigError> {
    let nl = eng.netlist().clone();
    apply_loads(eng, &nl, cfg)?;
    apply_pokes_delay(eng, &nl, cfg)?;
    let deadline = cfg.limits.timeout.map(|t| started + t);

    // -- Run in chunks, checking limits between --------------------------
    let mut remaining = cfg.limits.max_cycles;
    let mut halt: Option<(GradeOutcome, &'static str, String)> = None;
    let mut last_report = RunReport {
        cycles: 0,
        t_obs: 0,
        violations: Vec::new(),
        top_paths: Vec::new(),
        trace_hash: 0,
        events_processed: 0,
    };
    while remaining > 0 && halt.is_none() {
        let chunk = remaining.min(RUN_CHUNK);
        match eng.run(chunk) {
            Ok(rep) => last_report = rep,
            Err(h) => {
                let (oc, reason) = halt_outcome(&h);
                halt = Some((oc, reason, h.details));
            }
        }
        remaining = remaining.saturating_sub(chunk);
        if halt.is_none() {
            if let Some((oc, reason)) = limits_tripped(cfg, deadline) {
                halt = Some((oc, reason, String::new()));
            }
        }
    }

    let cycles = eng.cycle();
    let t_obs = eng.t_obs();
    let est_time = cycles.saturating_mul(t_obs);

    // -- Assertions ------------------------------------------------------
    let violation_count = eng.violations().len() as u64;
    let results: Vec<AssertionResult> = cfg
        .assertions
        .iter()
        .map(|a| eval_assertion(a, &DelayProbe(eng), violation_count))
        .collect();

    // -- Outcome (precedence in module docs) ------------------------------
    let all_passed = results.iter().all(|r| r.passed);
    let (outcome, halt_reason, halt_details) = match halt {
        Some((oc, reason, details)) => (oc, reason.to_string(), details),
        None if cfg.expect_halt => (
            GradeOutcome::CycleLimit,
            "cycle-limit".to_string(),
            format!(
                "{} cycles without a halt (expect_halt set)",
                cfg.limits.max_cycles
            ),
        ),
        None if all_passed => (GradeOutcome::Passed, "completed".to_string(), String::new()),
        None => (
            GradeOutcome::AssertionFailed,
            "completed".to_string(),
            String::new(),
        ),
    };

    // -- STA (informational) ----------------------------------------------
    let (t_sta, sta_note) = if cfg.include_sta {
        match sta::analyze(&nl, table, cfg.top_k) {
            Ok(r) => (
                Some(r.t_sta),
                Some("structural bound — may include paths your design never uses".to_string()),
            ),
            Err(e) => (None, Some(e.to_string())),
        }
    } else {
        (None, None)
    };

    let report = Report {
        cycles,
        halt_reason,
        halt_details,
        t_obs,
        est_time,
        speedup_vs_baseline: cfg
            .baseline_est_time
            .filter(|_| est_time > 0)
            .map(|b| b as f64 / est_time as f64),
        timing_violations: eng.violations().len() as u64,
        violation_details: eng
            .violations()
            .iter()
            .map(|v| api_violation(&nl, v))
            .collect(),
        assertions: results,
        top_paths: last_report
            .top_paths
            .iter()
            .take(cfg.top_k)
            .flat_map(|(settle, path)| api_path(&nl, *settle, path))
            .collect(),
        t_sta,
        sta_note,
        delay_table: format!("{} ({})", table.name(), table.status()),
        trace_hash: Some(eng.trace_hash()),
        rubric_full_credit: cfg.rubric_full_credit_below.map(|t| est_time < t),
        errors: Vec::new(),
        peak_rss_bytes: peak_rss_bytes(),
        wall_time_ms: started.elapsed().as_millis() as u64,
    };
    Ok(GradeOutput { report, outcome })
}

// -- Assertion evaluation -------------------------------------------------

/// Named-value view of the delay-aware engine.
trait ProbeView {
    fn probe_value(&self, name: &str) -> Option<Value>;
    fn mem_word(&self, name: &str, addr: u64) -> Option<Value>;
}

struct DelayProbe<'a>(&'a DelayEngine);

impl ProbeView for DelayProbe<'_> {
    fn probe_value(&self, name: &str) -> Option<Value> {
        self.0.named_value(name)
    }
    fn mem_word(&self, name: &str, addr: u64) -> Option<Value> {
        self.0.memory_word(name, addr)
    }
}

fn eval_assertion(a: &Assertion, view: &dyn ProbeView, violation_count: u64) -> AssertionResult {
    let text = render_assertion(a);
    let expected = format!("{} 0x{:X}", a.op().as_str(), a.value());
    let (observed, actual) = match a {
        Assertion::Probe { name, .. } => match view.probe_value(name) {
            Some(v) => (numeric(&v), render_actual(&v)),
            None => (None, format!("<unknown probe '{name}'>")),
        },
        Assertion::Mem { name, addr, .. } => match view.mem_word(name, *addr) {
            Some(v) => (numeric(&v), render_actual(&v)),
            None => (None, format!("<unknown memory '{name}'>")),
        },
        Assertion::Violations { .. } => (Some(violation_count), violation_count.to_string()),
    };
    let passed = observed.is_some_and(|n| a.op().apply(n, a.value()));
    AssertionResult {
        assertion: text,
        passed,
        actual,
        expected,
    }
}

impl Assertion {
    fn op(&self) -> CmpOp {
        match self {
            Assertion::Probe { op, .. }
            | Assertion::Mem { op, .. }
            | Assertion::Violations { op, .. } => *op,
        }
    }

    fn value(&self) -> u64 {
        match self {
            Assertion::Probe { value, .. }
            | Assertion::Mem { value, .. }
            | Assertion::Violations { value, .. } => *value,
        }
    }
}

fn render_assertion(a: &Assertion) -> String {
    match a {
        Assertion::Probe { name, op, value } => {
            format!("probe('{name}') {} 0x{value:X}", op.as_str())
        }
        Assertion::Mem {
            name,
            addr,
            op,
            value,
        } => format!("mem('{name}')[0x{addr:X}] {} 0x{value:X}", op.as_str()),
        Assertion::Violations { op, value } => format!("violations {} 0x{value:X}", op.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::load_document;

    const SETTINGS: &str = r#""settings":{"clockHz":1,"delayTable":"cs2200-74ls-v1"}"#;

    /// Toggling counter + named RAM: r1 flips each cycle, r2 follows one
    /// behind; probe `out` = and(n1.out, 1). T_obs = clk→Q 20 + not 9 +
    /// and 10 = 39. RAM idle (we=0), preloaded by tests.
    fn counter_json() -> String {
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zw","type":"wiring.constant","pos":[0,0]}},
                {{"id":"za","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":4}}}},
                {{"id":"zd","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":32}}}},
                {{"id":"r1","type":"mem.register","pos":[0,0],"name":"r1"}},
                {{"id":"n1","type":"gate.not","pos":[0,0]}},
                {{"id":"a1","type":"gate.and","pos":[0,0]}},
                {{"id":"r2","type":"mem.register","pos":[0,0],"name":"r2"}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out"}},
                {{"id":"dmem","type":"mem.ram","pos":[0,0],"name":"dmem",
                  "attrs":{{"bitsize":32,"depth":16}}}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r2","pin":"clk"}}}},
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"dmem","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r2","pin":"en"}}}},
                {{"a":{{"comp":"zw","pin":"out"}},"b":{{"comp":"r1","pin":"rst"}}}},
                {{"a":{{"comp":"zw","pin":"out"}},"b":{{"comp":"r2","pin":"rst"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"a1","pin":"in1"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"n1","pin":"in"}}}},
                {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}},
                {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"a1","pin":"in0"}}}},
                {{"a":{{"comp":"a1","pin":"out"}},"b":{{"comp":"r2","pin":"d"}}}},
                {{"a":{{"comp":"a1","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}},
                {{"a":{{"comp":"za","pin":"out"}},"b":{{"comp":"dmem","pin":"addr"}}}},
                {{"a":{{"comp":"zd","pin":"out"}},"b":{{"comp":"dmem","pin":"din"}}}},
                {{"a":{{"comp":"zw","pin":"out"}},"b":{{"comp":"dmem","pin":"we"}}}}
            ]}}]
        }}"##
        )
    }

    fn doc(json: &str) -> Document {
        load_document(json.as_bytes()).expect("test doc loads")
    }

    fn cfg3() -> GradeConfig {
        GradeConfig {
            limits: RunLimits {
                max_cycles: 3,
                ..RunLimits::default()
            },
            ..GradeConfig::default()
        }
    }

    // ---- Assertion parser ------------------------------------------------

    #[test]
    fn parser_accepts_all_forms_ops_and_literals() {
        assert_eq!(
            parse_assertion("probe('result') == 0x2A").unwrap(),
            Assertion::Probe {
                name: "result".into(),
                op: CmpOp::Eq,
                value: 0x2A
            }
        );
        assert_eq!(
            parse_assertion("mem('dmem')[0x100] <= 0x1234").unwrap(),
            Assertion::Mem {
                name: "dmem".into(),
                addr: 0x100,
                op: CmpOp::Le,
                value: 0x1234
            }
        );
        assert_eq!(
            parse_assertion("violations!=3").unwrap(),
            Assertion::Violations {
                op: CmpOp::Ne,
                value: 3
            }
        );
        for (text, op) in [
            ("==", CmpOp::Eq),
            ("!=", CmpOp::Ne),
            ("<", CmpOp::Lt),
            ("<=", CmpOp::Le),
            (">", CmpOp::Gt),
            (">=", CmpOp::Ge),
        ] {
            let a = parse_assertion(&format!("violations {text} 7")).unwrap();
            assert_eq!(a.op(), op, "{text}");
        }
        assert_eq!(
            parse_assertion("probe('x') == 0b101").unwrap(),
            Assertion::Probe {
                name: "x".into(),
                op: CmpOp::Eq,
                value: 5
            }
        );
        assert_eq!(
            parse_assertion(" probe( 'x' )  >=  42 ").unwrap(),
            Assertion::Probe {
                name: "x".into(),
                op: CmpOp::Ge,
                value: 42
            }
        );
    }

    #[test]
    fn parser_rejects_malformed() {
        for bad in [
            "",
            "probe(x) == 1",
            "probe('x') = 1",
            "probe('x') == ",
            "probe('x') == 1 junk",
            "probe('x') == 0x",
            "mem('dmem') == 1",
            "mem('dmem')[0x100] < ",
            "mem(dmem)[0] == 1",
            "violation == 0",
            "register('r1') == 1",
            "probe('x') == -1",
        ] {
            assert!(parse_assertion(bad).is_err(), "{bad}");
        }
    }

    // ---- Happy path + report fields --------------------------------------

    #[test]
    fn passing_run_exit_0_and_all_report_fields() {
        let mut cfg = cfg3();
        cfg.assertions = vec![
            parse_assertion("probe('r1') == 1").unwrap(),
            parse_assertion("probe('r2') == 0b1").unwrap(),
            parse_assertion("probe('out') == 0x0").unwrap(),
            parse_assertion("mem('dmem')[2] == 0x2A").unwrap(),
            parse_assertion("mem('dmem')[0] == 0").unwrap(),
            parse_assertion("violations == 0").unwrap(),
        ];
        cfg.loads = vec![("dmem".into(), LoadSource::Words(vec![0, 0, 0x2A]))];
        cfg.baseline_est_time = Some(234);
        cfg.rubric_full_credit_below = Some(200);
        cfg.include_sta = true;
        let out = grade(&doc(&counter_json()), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::Passed);
        assert_eq!(out.outcome.exit_code(), EXIT_OK);
        let r = &out.report;
        assert_eq!(r.cycles, 3);
        assert_eq!(r.halt_reason, "completed");
        assert_eq!(r.t_obs, 39);
        assert_eq!(r.est_time, 3 * 39);
        assert_eq!(r.speedup_vs_baseline, Some(2.0));
        assert_eq!(r.timing_violations, 0);
        assert!(r.assertions.iter().all(|a| a.passed));
        assert_eq!(r.assertions.len(), 6);
        assert!(!r.top_paths.is_empty());
        assert_eq!(r.top_paths[0].delay_ns, 39);
        assert_eq!(r.top_paths[0].circuit, "main");
        // r1 is the 6th component in the fixture's document order.
        assert!(r.top_paths[0].comps.contains(&CompId(5)));
        assert_eq!(r.t_sta, Some(34));
        assert!(r.sta_note.as_deref().unwrap().contains("structural bound"));
        assert_eq!(r.delay_table, "cs2200-74ls-v1 (DRAFT)");
        assert!(r.trace_hash.is_some());
        assert_eq!(r.rubric_full_credit, Some(true));
        assert!(r.errors.is_empty());
        assert!(r.peak_rss_bytes.unwrap_or(1) > 0);
    }

    #[test]
    fn identical_runs_identical_sim_fields() {
        let mut cfg = cfg3();
        cfg.assertions = vec![parse_assertion("probe('r1') == 1").unwrap()];
        let a = grade(&doc(&counter_json()), &cfg).unwrap();
        let b = grade(&doc(&counter_json()), &cfg).unwrap();
        assert_eq!(a.report.trace_hash, b.report.trace_hash);
        assert_eq!(a.report.cycles, b.report.cycles);
        assert_eq!(a.report.t_obs, b.report.t_obs);
        assert_eq!(a.report.assertions, b.report.assertions);
    }

    // ---- Assertion semantics ----------------------------------------------

    #[test]
    fn failing_probe_assertion_exit_1() {
        let mut cfg = cfg3();
        cfg.assertions = vec![parse_assertion("probe('r1') == 0").unwrap()];
        let out = grade(&doc(&counter_json()), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::AssertionFailed);
        assert_eq!(out.outcome.exit_code(), EXIT_ASSERTION_FAILED);
        assert_eq!(out.report.halt_reason, "completed");
        assert!(!out.report.assertions[0].passed);
        assert_eq!(out.report.assertions[0].actual, "0x1");
        assert_eq!(out.report.assertions[0].expected, "== 0x0");
    }

    #[test]
    fn x_value_never_equals_a_literal() {
        // Two enabled controlled buffers drive different values onto one
        // net → contention X on the probe (§4.1: X is not a number).
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"b1","type":"wiring.controlled-buffer","pos":[0,0]}},
                {{"id":"b2","type":"wiring.controlled-buffer","pos":[0,0]}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"bus"}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"b1","pin":"in"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"b2","pin":"in"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"b1","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"b2","pin":"en"}}}},
                {{"a":{{"comp":"b1","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}},
                {{"a":{{"comp":"b2","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut cfg = cfg3();
        cfg.assertions = vec![parse_assertion("probe('bus') == 0").unwrap()];
        let out = grade(&doc(&json), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::AssertionFailed);
        assert!(
            out.report.assertions[0].actual.contains("x=0x1"),
            "{:?}",
            out.report.assertions[0]
        );
    }

    #[test]
    fn violations_assertion_and_report_entries() {
        // Half=1000 → rising edges at 2000/4000. Edge @2000 clean; d
        // changes at 3990 (setup 15 before edge @4000) and 4003 (hold 5
        // after it). Setup tracking begins at the first observed edge —
        // a pre-first-edge change has no defined window start (B6
        // engine semantics).
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"d","type":"wiring.pin","pos":[0,0],"name":"d"}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r","pin":"rst"}}}},
                {{"a":{{"comp":"d","pin":"pin"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let mut cfg = GradeConfig {
            clock_half_period: 1000,
            limits: RunLimits {
                max_cycles: 2,
                ..RunLimits::default()
            },
            ..GradeConfig::default()
        };
        cfg.pokes = vec![
            Poke {
                target: "d".into(),
                value: 1,
                at: 3990,
            },
            Poke {
                target: "d".into(),
                value: 0,
                at: 4003,
            },
        ];
        cfg.assertions = vec![
            parse_assertion("violations == 2").unwrap(),
            parse_assertion("violations > 0").unwrap(),
            parse_assertion("violations < 3").unwrap(),
        ];
        let out = grade(&doc(&json), &cfg).unwrap();
        assert_eq!(
            out.outcome,
            GradeOutcome::Passed,
            "{:?}",
            out.report.assertions
        );
        assert_eq!(out.report.timing_violations, 2);
        let v = &out.report.violation_details;
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].kind, crate::api::ViolationKind::Setup);
        assert_eq!(v[1].kind, crate::api::ViolationKind::Hold);
        assert_eq!(v[0].circuit, "main");
        // `r` is the 5th component in the fixture's document order.
        assert_eq!(v[0].comp_id, CompId(4));
    }

    // ---- Exit-code paths ---------------------------------------------------

    #[test]
    fn cycle_limit_exit_2_when_expect_halt() {
        let mut cfg = cfg3();
        cfg.expect_halt = true;
        let out = grade(&doc(&counter_json()), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::CycleLimit);
        assert_eq!(out.outcome.exit_code(), EXIT_CYCLE_LIMIT);
        assert_eq!(out.report.halt_reason, "cycle-limit");
        assert_eq!(out.report.cycles, 3);
    }

    #[test]
    fn timeout_exit_3() {
        let mut cfg = cfg3();
        cfg.limits.timeout = Some(Duration::from_millis(0));
        let out = grade(&doc(&counter_json()), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::Timeout);
        assert_eq!(out.outcome.exit_code(), EXIT_TIMEOUT);
        assert_eq!(out.report.halt_reason, "timeout");
    }

    #[test]
    fn oscillation_exit_4() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"g","type":"gate.nand","pos":[0,0]}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"p"}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"g","pin":"in1"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"g","pin":"in0"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let cfg = cfg3();
        let out = grade(&doc(&json), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::Oscillation);
        assert_eq!(out.outcome.exit_code(), EXIT_OSCILLATION);
        assert_eq!(out.report.halt_reason, "oscillation");
    }

    #[test]
    fn floating_read_exit_5() {
        // Register d ← controlled buffer with en tied to 0: the net is
        // driven (no load error) but floats at the edge (§4.1).
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"b","type":"wiring.controlled-buffer","pos":[0,0]}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"b","pin":"in"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"b","pin":"en"}}}},
                {{"a":{{"comp":"b","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let out = grade(&doc(&json), &cfg3()).unwrap();
        assert_eq!(out.outcome, GradeOutcome::FloatingRead);
        assert_eq!(out.outcome.exit_code(), EXIT_FLOATING_READ);
        assert_eq!(out.report.halt_reason, "floating-read");
        assert!(
            out.report.halt_details.contains('r'),
            "{:?}",
            out.report.halt_details
        );
    }

    #[test]
    fn malformed_file_exit_6() {
        // Parses + validates, but netlist build fails (bitsize mismatch).
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"a","type":"wiring.pin","pos":[0,0],"name":"a"}},
                {{"id":"b","type":"wiring.pin","pos":[0,0],"name":"b","attrs":{{"bitsize":32}}}}
            ], "wires": [
                {{"a":{{"comp":"a","pin":"pin"}},"b":{{"comp":"b","pin":"pin"}}}}
            ]}}]
        }}"##
        );
        let out = grade(&doc(&json), &cfg3()).unwrap();
        assert_eq!(out.outcome, GradeOutcome::MalformedFile);
        assert_eq!(out.outcome.exit_code(), EXIT_MALFORMED_FILE);
        assert_eq!(out.report.halt_reason, "malformed-file");
        assert!(!out.report.errors.is_empty());
    }

    // ---- Preload from file -------------------------------------------------

    #[test]
    fn memory_preload_from_rle_hex_file() {
        let dir = std::env::temp_dir().join(format!("csim-b9-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.hex");
        std::fs::write(&path, "0 0 2a 7-0\n").unwrap(); // word 2 = 0x2a
        let mut cfg = cfg3();
        cfg.loads = vec![("dmem".into(), LoadSource::File(path.clone()))];
        cfg.assertions = vec![
            parse_assertion("mem('dmem')[2] == 0x2A").unwrap(),
            parse_assertion("mem('dmem')[15] == 0").unwrap(),
        ];
        let out = grade(&doc(&counter_json()), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::Passed);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- Config errors -------------------------------------------------------

    #[test]
    fn config_errors_are_not_grading_outcomes() {
        let d = doc(&counter_json());
        let mut cfg = cfg3();
        cfg.assertions = vec![parse_assertion("probe('nope') == 1").unwrap()];
        assert!(matches!(grade(&d, &cfg), Err(ConfigError(_))));

        let mut cfg = cfg3();
        cfg.assertions = vec![parse_assertion("mem('out')[0] == 1").unwrap()];
        assert!(matches!(grade(&d, &cfg), Err(ConfigError(_)))); // probe, not memory

        let mut cfg = cfg3();
        cfg.assertions = vec![parse_assertion("probe('dmem') == 1").unwrap()];
        assert!(matches!(grade(&d, &cfg), Err(ConfigError(_)))); // RAM, not probe

        let mut cfg = cfg3();
        cfg.loads = vec![("nope".into(), LoadSource::Words(vec![0]))];
        assert!(matches!(grade(&d, &cfg), Err(ConfigError(_))));

        let mut cfg = cfg3();
        cfg.loads = vec![(
            "dmem".into(),
            LoadSource::File(std::path::PathBuf::from("/no/such/file.hex")),
        )];
        assert!(matches!(grade(&d, &cfg), Err(ConfigError(_))));

        let mut cfg = cfg3();
        cfg.pokes = vec![Poke {
            target: "nope".into(),
            value: 1,
            at: 0,
        }];
        assert!(matches!(grade(&d, &cfg), Err(ConfigError(_))));
    }

    // ---- F1/F4/F5: untrusted-image and poke robustness ----------------------

    #[test]
    fn f1_preload_word_wider_than_bitsize_is_a_config_error() {
        // RAM bitsize 8, image contains 0x1ff — was a panic (value.rs
        // from_u64); now a clean ConfigError (§11).
        // dmem is 32-bit: use a 33-bit word.
        let d = doc(&counter_json());
        let mut cfg = cfg3();
        cfg.loads = vec![("dmem".into(), LoadSource::Words(vec![0x1_FFFF_FFFF]))];
        let e = grade(&d, &cfg).expect_err("must be a ConfigError, not a panic");
        assert!(e.to_string().contains("does not fit"), "{e}");
    }

    #[test]
    fn f4_preload_uses_default_depth_when_attr_absent() {
        // A RAM without an explicit `depth` attr defaults to 256 words
        // (components.rs); preloading it must not error.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"za","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":8}}}},
                {{"id":"zw","type":"wiring.constant","pos":[0,0]}},
                {{"id":"m","type":"mem.ram","pos":[0,0],"name":"m","attrs":{{"bitsize":8}}}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"m","pin":"clk"}}}},
                {{"a":{{"comp":"za","pin":"out"}},"b":{{"comp":"m","pin":"addr"}}}},
                {{"a":{{"comp":"zw","pin":"out"}},"b":{{"comp":"m","pin":"we"}}}}
            ]}}]
        }}"##
        );
        let mut cfg = cfg3();
        cfg.loads = vec![("m".into(), LoadSource::Words(vec![0x2A; 300]))]; // > 256: extra ignored
        cfg.assertions = vec![parse_assertion("mem('m')[0] == 0x2A").unwrap()];
        let out = grade(&doc(&json), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::Passed, "{:?}", out.report);
    }

    #[test]
    fn f5_poke_value_wider_than_pin_is_a_config_error() {
        // A 1-bit pin and a 9-bit poke value.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"p","type":"wiring.probe","pos":[5,0],"name":"out"}}
            ], "wires": [
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let d = doc(&json);
        let mut cfg = cfg3();
        cfg.pokes = vec![Poke {
            target: "src".into(),
            value: 0x1FF, // pin is 1 bit
            at: 0,
        }];
        let e = grade(&d, &cfg).expect_err("must be a ConfigError, not a panic");
        assert!(e.to_string().contains("does not fit"), "{e}");
    }

    // ---- TestSpec (§8.3) -----------------------------------------------------

    #[test]
    fn test_spec_maps_to_config() {
        let dir = std::env::temp_dir().join(format!("csim-b9-spec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("data.hex"), "0 0 2a\n").unwrap();
        let spec = TestSpec::from_json(
            br#"{
                "cycles": 3,
                "timeout_ms": 60000,
                "baseline_est_time": 234,
                "expect_halt": false,
                "top_paths": 5,
                "include_sta": true,
                "rubric_full_credit_below": 200,
                "clock_half_period_ns": 500,
                "loads": [{"memory": "dmem", "file": "data.hex"}],
                "pokes": [{"target": "d", "value": "0x2A", "at": 100}],
                "assertions": ["probe('r1') == 1", "violations == 0",
                               "mem('dmem')[2] == 0x2A"]
            }"#,
        )
        .unwrap();
        let cfg = spec.into_config(&dir).unwrap();
        assert_eq!(cfg.limits.max_cycles, 3);
        assert_eq!(cfg.limits.timeout, Some(Duration::from_millis(60000)));
        assert_eq!(cfg.baseline_est_time, Some(234));
        assert_eq!(cfg.top_k, 5);
        assert!(cfg.include_sta);
        assert_eq!(cfg.rubric_full_credit_below, Some(200));
        assert_eq!(cfg.clock_half_period, 500);
        assert_eq!(cfg.assertions.len(), 3);
        assert_eq!(cfg.pokes.len(), 1);
        assert_eq!(cfg.pokes[0].value, 0x2A);
        match &cfg.loads[0].1 {
            LoadSource::File(p) => assert_eq!(p, &dir.join("data.hex")),
            _ => panic!("expected file load"),
        }
        // ...and the config actually grades (file load included; the
        // poke is dropped — the counter fixture has no pin named "d";
        // pokes are covered end-to-end by the violations test).
        let mut cfg = cfg;
        cfg.pokes.clear();
        let out = grade(&doc(&counter_json()), &cfg).unwrap();
        assert_eq!(out.outcome, GradeOutcome::Passed);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_spec_rejects_bad_assertion_and_poke_value() {
        let bad_assert = TestSpec::from_json(br#"{"assertions": ["probe('x') = 1"]}"#)
            .unwrap()
            .into_config(std::path::Path::new("."));
        assert!(bad_assert.is_err());
        let bad_poke =
            TestSpec::from_json(br#"{"pokes": [{"target": "d", "value": "hello", "at": 0}]}"#)
                .unwrap()
                .into_config(std::path::Path::new("."));
        assert!(bad_poke.is_err());
        let unknown_field = TestSpec::from_json(br#"{"cyclez": 3}"#);
        assert!(unknown_field.is_err());
    }
}
