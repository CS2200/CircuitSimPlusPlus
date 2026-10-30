# Profiling & benchmarking the simulation engine

How to find where the engine spends its time, prove a change helped, and keep it correct.
Audience: whoever (human or agent) is asked to make `csim-core` faster.

The **corpus**-side tooling (grading/benchmarking the whole 357-submission Gradescope
export, and the old-autograder oracle) lives in the transpiler repo:
`circuitsim-transpiler/docs/05-corpus-benchmarking.md`. This file is the *engine* side.

---

## 0. Two ground rules

1. **Determinism is a hard invariant** (DESIGN.md §4.6): no `HashMap` iteration, floats,
   wall-clock, or RNG in evaluation/serialization. The golden trace-hash suite
   (`crates/core/tests/golden.rs`) is the tripwire.
2. **Measure on a release build, and don't run anything else on the machine.** Perf numbers
   are wall-clock; a concurrent corpus run / build / `perf` session skews them. The first
   benchmark in this repo's history was inflated ~30% by a background job.

---

## 1. Build the release binary

```sh
cargo build -p csim --release            # -> target/release/csim
```

`cargo test -p csim-core --release` also produces the test binary used by the perf probe.

---

## 2. The synthetic perf probe

There is an `#[ignore]`d microbenchmark next to the engine, `delay::perf_probe::
pipeline_100k_cycles`. It loads a synthetic 5-stage pipeline and runs 100k cycles, printing
events and throughput:

```sh
cargo test -p csim-core --release pipeline_100k_cycles -- --ignored --nocapture

# 100k cycles, 2500030 events in 266ms (25 events/cycle, 9.4 Mevents/s)
```

Run it 3–5 times and take the best (first run pays page-faults). It is small and
allocation-heavy, so it is a good *relative* signal but not representative of a real CPU —
for that use the fixtures below.

## 3. The real fixtures

`tests/fixtures/pipeline5.csx` (5-stage CPU, ~120 components) and `multicycle.csx` are the
realistic workloads. Time a fixed cycle count with the CLI:

```sh
./target/release/csim run tests/fixtures/pipeline5.csx --cycles 100000 --json /tmp/opencode/rep.json
# rep.json has wall_time_ms, peak_rss_bytes, cycles, t_obs

# loop for stability:
for i in 1 2 3; do /usr/bin/time -f '%e s' ./target/release/csim run \
    tests/fixtures/pipeline5.csx --cycles 100000 >/dev/null; done
```

Heavy designs are event-count-bound, not per-cycle bound: ~25 events/cycle on the synthetic
pipeline vs hundreds on a real one. Compare with `report.json`'s `wall_time_ms`.

---

## 4. `perf` — where the time goes

```sh
BIN=$(ls -t target/release/deps/csim_core-* | grep -v '\.d$' | head -1)
perf record -F 9999 -g -o /tmp/opencode/perf.data -- \
    "$BIN" pipeline_100k_cycles --ignored --nocapture

# flat, top functions:
perf report -i /tmp/opencode/perf.data --stdio --no-children --percent-limit 0.6

# call graph (children):
perf report -i /tmp/opencode/perf.data --stdio -g --percent-limit 1
```

For the **real** path, profile the CLI instead (careful: `run`/`timing` differ slightly):

```sh
perf record -F 9999 -g -o /tmp/opencode/perf.data -- \
    ./target/release/csim run tests/fixtures/pipeline5.csx --cycles 100000
```

**Line-level attribution** needs debug info:

```sh
CARGO_PROFILE_RELEASE_DEBUG=1 CARGO_TARGET_DIR=/tmp/opencode/target \
    cargo build -p csim-core --release --tests
perf record -F 9999 -g -o /tmp/opencode/perfd.data -- \
    /tmp/opencode/target/release/deps/csim_core-* pipeline_100k_cycles --ignored --nocapture
perf annotate -i /tmp/opencode/perfd.data --stdio > /tmp/opencode/annotate.txt
# the section for `apply` starts at the `<...DelayEngine>::apply>:` header and ends at the
# next symbol header; each asm line is prefixed with its % of that symbol.
```

A useful awk over `annotate.txt` (prints hot lines with their source statement):

```sh
awk 'NR<8{next} NR>=<end>{exit} /^ *: [0-9]+ /{src=$0; next} \
     /^[ ]+[0-9]+\.[0-9]+ :/{p=$1+0; if(p>=1.5) printf "%5.2f%%  %s\n",p,src}' \
     /tmp/opencode/annotate.txt | sort -rn | head -40
```

---

## 5. Proving a change helped — the HEAD A/B

Build the *unmodified* tree into a separate target dir, then time both binaries. Edit only
the files you changed (create a `target_base` once):

```sh
git show HEAD:crates/core/src/delay.rs > /tmp/opencode/delay_base.rs   # per changed file
cp crates/core/src/delay.rs /tmp/opencode/delay_new.rs
cp /tmp/opencode/delay_base.rs crates/core/src/delay.rs
CARGO_TARGET_DIR=/tmp/opencode/target_base cargo build -p csim --release
cp /tmp/opencode/delay_new.rs crates/core/src/delay.rs                 # restore
# then: /tmp/opencode/target_base/release/csim   vs   target/release/csim
```

For the corpus-wide A/B see `circuitsim-transpiler/docs/05-corpus-benchmarking.md` §4.

---

## 6. Keep it correct

```sh
cargo fmt --all -- --check
cargo clippy -p csim-core -p csim --all-targets -- -D warnings
cargo test -p csim-core -p csim --release      # 245 unit + 9 golden + 14 CLI
```

**Golden traces.** `crates/core/tests/golden.rs` pins `t_obs` and `trace_hash` per fixture.
A *value* change must not move `t_obs`; a change that alters the event stream (or the hash
function itself) moves `trace_hash` and must be re-blessed:

```sh
CSIM_BLESS=1 cargo test -p csim-core --release --test golden golden_traces_are_pinned -- --nocapture
```

It **prints** the new table (it does not rewrite the file) — paste the values into
`SCENARIOS`, then run the plain test to confirm, and record *why* in the commit message.
`t_obs` should be unchanged unless the change is intentional.

---

## 7. What has already been optimized (and what is left)

From profiling the 100k-cycle pipeline and the real CLI (see `git log` for the commits).
Keeping this list saves the next person from re-deriving it.

**Done (all verdict-neutral on the corpus; ~25–28% faster on `pipeline5`/`multicycle`,
~42% on the synthetic probe):**

* **Debug env reads off the hot path.** `CSIM_DEBUG_SETTLE` was `std::env::var(..).is_ok()`
  inside the `Deliver` apply arm — a full `getenv` scan *per delivered event* (~5%). Cached
  in a `OnceLock` (`debug_settle()`), like the other `CSIM_DEBUG_*` flags.
* **`floating_sweep` short-circuit.** The cycle-close floating-read sweep's only observable
  effect is the `pause_on_unknown` pause; its evaluations are pure reads that are otherwise
  discarded. It now returns immediately when `pause_on_unknown` is off (graded/default runs)
  (~5%). Set `pause_on_unknown` and the sweep runs as before.
* **Event queue: slab-indexed binary heap** (`EventQueue`). The old shape was
  `BTreeMap<u64, [VecDeque<Ev>; 2]>` — one `VecDeque` allocated+freed per *distinct
  timestamp*. Now a `BinaryHeap<Reverse<(time, prio, seq, u32)>>` of slab indices, with the
  `Ev` payloads in a reused slab. Ordering is identical: `(time, prio, seq)` is a total order
  (`seq` is unique).
* **Word-wise trace hash.** `Value::fold_bytes` fed byte-wise FNV-1a; the serial recurrence
  was ~20% of a run. `hash_event` now mixes `Value::fold_words` (one 64-bit word per limb)
  with a word-wise FNV-style mix. The digest changed → the golden hashes were re-blessed
  (`t_obs` unmoved) and `docs/autograder.md` now describes it. This is the one change that
  moves a documented value; revert it if the team prefers the byte-wise digest.
* **`Value` single-limb fast paths.** `and`/`or`/`xor`, `not`, and `contention_merge_detail`
  allocated three one-element `Vec<u64>`s per call for any width ≤ 64 (i.e. almost every
  value); they now compute on the stack (`Limbs::Inline`). `n == 0` keeps the general path.

**Left on the table:**

* The event queue is still ~15–18% (`BinaryHeap::pop` + slab push/pop). A **radix/bucket
  queue** is viable because times are nondecreasing in schedule order (the derived clock
  drains before it schedules), but it is a larger change.
* `apply` self-time (~25%) is dominated by per-event `Arc::new(resolve(..))`, `Arc::clone`
  into `views`, and `Value` clones (`net_values`, `pending_val`). Dropping
  `Arc<Value>` for `Value` (now inline-small) is the candidate rewrite.
* The per-evaluation `Vec<Arc<Value>>` construction (~7%) is **`Arc` clone cost, not
  allocation** — reusing a scratch buffer was tried and did **not** help; do not bother.
* `Value::bit` (~4%) is called from the clock/enable paths.

### Gotchas discovered

* `wire.num = 0` in the shipped delay tables (`docs/delay-table.md`), so per-path wire
  delays are *computed but zero* — don't "optimize" the per-path machinery, it's inert.
* The engine is **event-count-bound**: 25 events/cycle (synthetic) vs hundreds (real CPU).
  Reducing per-event cost pays; reducing *cycle* count does not exist as a lever.
* `Arc<Value>` sharing was introduced to avoid deep-copying `Value` into every sink view;
  with `Value` now inline-small the trade-off has changed (see "left on the table").
* The corpus end-to-end cost is **engine-bound** (~90% is `csim run`; conversion +
  `validate` + the name-probe are the rest), so engine work is the lever — not the harness.
  (An earlier note here said the opposite; the stage timings in the transpiler doc's
  `corpus_bench` table correct it.)

---

## 8. Recorded profile & benchmark numbers

Snapshot **2026-10-30**, post-optimization, on the machine used throughout (a 4-core/8-SMT
i5-1135G7). Recorded so a future agent does not have to re-derive the baseline.

### Engine hot symbols

`perf record -F 9999 -g` on `csim run tests/fixtures/pipeline5.csx --cycles 100000`
(release), flat, `--no-children`:

| % | symbol | what |
|--:|---|---|
| 24.1 | `DelayEngine::apply` | the event dispatch; self-time is the `Fire`/`Deliver` arms |
| 8.1 | `BinaryHeap::pop` | event queue |
| 7.9 | `eval_and_schedule` | evaluate a part + schedule its commit |
| 5.8 | `EventQueue::push` | event queue (slab) |
| 4.5 | `EventQueue::pop` | event queue (slab) |
| 4.5 | `Vec<Arc<Value>>::from_iter` (eval) | per-eval input list (`Arc` clones) |
| 4.1 | `clock_edge` | register/RAM edge path |
| 3.8 | `Value::bit` | clock/enable bit reads |
| 3.3 | `Vec<Arc<Value>>::from_iter` (clock) | per-edge input list (`Arc` clones) |
| 3.0 | `Behavior::eval_with` | the component behaviours |
| 2.7 + 2.3 | `malloc` + `cfree` | allocations |
| (tail) | `Value::clone`, `rising_edge_inner`, `clock_delivery`, `resolve*`, … | |

The two biggest actionable buckets are **the event queue (~18% together)** and **the
per-event `Arc`/`Value` traffic** (the `from_iter` rows + `Arc::new` inside `apply` + the
`malloc`/`free`), which is why those are §7's "left on the table". The synthetic probe
(`pipeline_100k_cycles`, ignored) is the quick relative check.

### Corpus: new vs old (measured)

Full 357-submission corpus (transpiler `tools/`); **normalize both sides** for concurrency
(6 `csim` workers = 1.53×, 4 JVMs = 1.57× on this box — the factors nearly cancel):

| | new (whole path) | new (sim only) | old (measured) |
|---|--:|--:|--:|
| raw as-run | 1227 s | 1096 s | 7035 s |
| normalized | 802 s (13.4 min) | 716 s (11.9 min) | 4481 s (74.7 min) |
| **speed-up** | — | — | **5.6× whole / 6.3× sim** |

Old side: 335/357 ran (one fresh JVM each), median 18.9 s, max 408 s. New synthetic probe:
266 ms / 9.4 Mevents/s. Fixture `pipeline5`, 100k cycles: ~2.3 s.

### Where the raw artifacts are

Under `/tmp/opencode/` (regenerate rather than rely on them surviving):

| file | what |
|---|---|
| `perf-final.data`, `perf-final.txt` | the engine profile above (`perf report -i … --stdio --no-children`) |
| `perfcli5.data`, `perf.data`, `perf2.data`, `perf3.data` | earlier profiles (pre/post each change) |
| `corpus-bench.json` | `corpus_bench.py` output (new timings + old sample + verdict diff) |
| `old-autograder-all.json` | all-357 old-autograder timings |
| `timings.md`, `timings-normalized.md` | the old-vs-new comparison |
| `corpus-new-compat.json`, `corpus-head-prod.json`, `corpus-new-prod.json` | corpus verdict reports |

The corpus tooling and its own guide live in the transpiler repo:
`circuitsim-transpiler/docs/05-corpus-benchmarking.md`.
