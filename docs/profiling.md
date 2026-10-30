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
* **Event queue: monotone radix heap** (`EventQueue`). History: `BTreeMap<u64,
  [VecDeque<Ev>;2]>` (a `malloc`/`free` per distinct timestamp) → `BinaryHeap` of
  `(time,prio,seq,idx)` + a slab → **radix heap**. The derived clock drains the queue to
  quiescence before timestamping the next transition, so events are scheduled at `now+delay
  ≥ now`: the queue is *monotone*, which is exactly what a radix heap exploits (amortized
  `O(1)` push/pop, `O(1)` peek). Buckets hold `u32` slab indices split into two FIFOs
  (priority 0/1; `seq` is insertion order), so the `(time,prio,seq)` order is unchanged. Two
  engine inserts are *below* the radix origin and go to a small linear `early` list:
  testbench pokes and deferred clocks. `peek` became `&mut` (it promotes the minimum at the
  point of consume). ~9% faster on 3.4k-component designs; ~3% slower on a 120-component
  fixture (tiny-queue constant overhead).
* **Word-wise trace hash.** `Value::fold_bytes` fed byte-wise FNV-1a; the serial recurrence
  was ~20% of a run. `hash_event` now mixes `Value::fold_words` (one 64-bit word per limb)
  with a word-wise FNV-style mix. The digest changed → the golden hashes were re-blessed
  (`t_obs` unmoved) and `docs/autograder.md` now describes it. This is the one change that
  moves a documented value; revert it if the team prefers the byte-wise digest.
* **`Value` single-limb fast paths.** `and`/`or`/`xor`, `not`, and `contention_merge_detail`
  allocated three one-element `Vec<u64>`s per call for any width ≤ 64 (i.e. almost every
  value); they now compute on the stack (`Limbs::Inline`). `n == 0` keeps the general path.
* **Evaluate off the views** (`eval_and_schedule`, `clock_edge`). They used to clone every
  input pin's view into an owned `Vec` before evaluating, then clone again to substitute a
  floating input. The common case has no floating input, so they now evaluate straight off
  the views by reference; owned copies are taken only when a consumed unknown forces a
  substitution. ~5–8% on 3.4k-component designs.
* **Inline single-limb `Value` (32 bytes, `Copy`); width capped at 64.** `Limbs` was
  `Inline(u64) | Heap(Vec<u64>)`, and the `Heap` variant made *every* `Limbs` 32 bytes (tag +
  `Vec`) and every `Value` **104 bytes and non-`Copy`** — which is why `Arc<Value>` felt
  necessary. The engine caps a value at 64 bits (bitsize ≤ 32, an adder carries to 33, the
  widest derived pin is a 32-bit multiplier's 64-bit output), so a mask is always one `u64`;
  `Limbs` is now a single-variant (payload-layout) enum, `Value` is 4+4+3×8 = 32 bytes and
  `Copy`. Test `value_is_small_and_copy` pins it. **~30% on 3.4k-component designs.**
* **Drop `Arc<Value>` (Arcless).** With `Value` `Copy` and 32 bytes, `Arc`'s heap allocation
  and atomic refcount traffic are pure overhead, so events, views, and the floating-input
  fallback store `Value` directly. Another **~20%**.

**History — the Arcless attempt that failed first.** Arcless was tried *before* the `Value`
shrink and **measured a wash to ~8% slower**: at 104 bytes, a `Value` copy cost more than an
8-byte `Arc` clone. The lesson is the ordering — **shrink `Value` first, then drop `Arc`.**
The other profitable change came from the same profile row that motivated Arcless
(`Vec<Arc<Value>>::from_iter`): that row was mostly the `Vec` allocation, not the `Arc`
clone, and "evaluate off the views" removes it more cheaply.

**Micro-optimizations tried and their measured value (2026-10-30 follow-up):**

The next "obvious" profile rows turned out to be **worth much less than their percent** —
a lesson in itself: `malloc`/`cfree` share is not time.

* **`compat` delivery fast path — NEUTRAL, reverted.** `compat` delivers CE's
  `getIncomingValue(port)` (all drivers *except the receiving port*); for a sink that is not a
  driver the value equals the all-drivers merge already computed, so I added a fast path.
  Measured neutral. A counter proved why: the slow path is taken **~6:1** (e.g. 1.46 M slow vs
  247 k fast) because in these designs the frequent receivers are themselves **drivers**
  (splitter InOut pins) or sit on nets with subcircuit boundaries, so the exclusion really
  applies. Don't re-attempt this without a counter.
* **Allocation reduction — ~1%, low ROI.** A counting `#[global_allocator]` showed the run
  does **~10 allocations per event** (25 M allocs / 100 k cycles on `pipeline5`). Removing the
  per-`Fire` `pending_val` clone (kept; `Value` is `Copy`, so the commit reads it in place)
  cut allocations ~6% for **~1%** time. So the `malloc`/`cfree` rows do **not** justify the
  wide `Behavior::eval` output-buffer refactor — the allocations are cheap.
* **Queue `min_index` fast path — ~1–3%, kept.** Skip the `early` scan when it's empty.

**Left on the table (the real levers):**

* **`apply`** self-time (~25–31%) is the dispatch — `resolve`, the per-sink delivery loop, the
  view/net updates. This is the honest next target and needs line-level `perf annotate`
  (careful: on big designs the annotate line mapping is unreliable — match by source *text*).
* The event queue (`push` + `pop` + `min_index`) ~16–20%.
* The behavior evaluation itself (`eval_with` etc.) — a wide refactor, only worth it if
  `annotate` shows the compute, not the allocation.
* **Trace hash (~12%)** — opt-in behind a flag (a contract decision; see §C in the report).

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
| 24.5 | `DelayEngine::apply` | the event dispatch |
| 7.6 | `EventQueue::push` | radix heap |
| 7.1 | `eval_and_schedule` | evaluate a part + schedule its commit |
| 6.9 | `EventQueue::min_index` | radix heap peek |
| 5.3 | `EventQueue::pop` | radix heap |
| 4.2 + 3.6 | `malloc` + `cfree` | `Vec` allocations (scratch/refs, behaviour-internal) |
| 3.8 | `Behavior::eval_with` | the component behaviours |
| 2.4 | `Behavior::eval_splitter` | splitters |
| 2.3 | `DelayEngine::run` | the run loop |
| 2.2 | `clock_delivery` | clocked-part bookkeeping |
| 2.2 | `Vec<&Value>::from_iter` (clock) | clock-edge input list |

No `Arc` rows remain. The queue is the **radix heap** (~20%: `push` + `min_index` + `pop`);
`apply` (~25%) is the top target; `malloc`/`cfree` are now plain `Vec` traffic. The synthetic
probe (`pipeline_100k_cycles`, ignored) is the quick relative check: ~**12.4 Mevents/s**.

### Corpus: new vs old (measured)

Full 357-submission corpus (transpiler `tools/`); **normalize both sides** for concurrency
(6 `csim` workers = 1.53×, 4 JVMs = 1.57× on this box — the factors nearly cancel):

| | new (whole path) | new (sim only) | old (measured) |
|---|--:|--:|--:|
| raw as-run | 710 s | 565 s | 7035 s |
| normalized | 464 s (7.7 min) | 369 s (6.2 min) | 4481 s (74.7 min) |
| **speed-up** | — | — | **9.7× whole / 12.1× sim** |

These are the **final** numbers (radix queue + evaluate-off-the-views + 32-byte `Copy`
`Value` + Arcless + the validate/named launch merge), all measured or normalized the same
way as the old side. Against the pre-session run at the same worker count, the new engine
went **whole path 1227→710 s (−42%)** and **simulation 1096→565 s (−48.5%)**; the corpus
stayed verdict-neutral (0 rows moved). Old side: 335/357 ran (one fresh JVM each), median
~19 s, max 408 s. Synthetic probe: ~12.4 Mevents/s; `pipeline5`, 100k cycles: ~1.2 s.

### Where the raw artifacts are

Under `/tmp/opencode/` (regenerate rather than rely on them surviving):

| file | what |
|---|---|
| `perf-final4.data` | the engine profile above (final) |
| `perf-final3.data`, `perf-final2.data`, `perf-final.data`, `perfcli5.data`, `perf.data`, `perf2.data`, `perf3.data` | earlier profiles (after each change) |
| `corpus-bench4.json` … `corpus-bench.json` | `corpus_bench.py` output after each stage (final … pre-session; new timings + old sample + verdict diff) |
| `old-autograder-all.json` | all-357 old-autograder timings |
| `timings.md`, `timings-normalized.md` | the old-vs-new comparison |
| `corpus-new-compat.json`, `corpus-head-prod.json`, `corpus-new-prod.json` | corpus verdict reports |

The corpus tooling and its own guide live in the transpiler repo:
`circuitsim-transpiler/docs/05-corpus-benchmarking.md`.
