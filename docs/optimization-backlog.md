# Optimization backlog — what's left (and why it's higher-risk)

**Status: parked.** The engine and the corpus harness are done for now. This file records
the *substantial* remaining ideas so a future contributor can pick one up without re-deriving
the whole picture. The micro-optimizations (and what they actually paid) are in
[`profiling.md`](profiling.md) §7–8; the corpus tooling is in
`circuitsim-transpiler/docs/05-corpus-benchmarking.md`.

## Where we are (measured 2026-10-30, before parking)

Machine: a 4-core / 8-SMT i5-1135G7. Corpus: the two-semester EC export, 357 submissions
(331 ran, 20 refused by the course's own gate, 6 the new engine could not simulate).

| metric | value |
|---|---|
| engine simulation, whole corpus | **542.7 s** raw at 6 workers (~355 s normalized) |
| whole grading path (convert + validate + run), whole corpus | **619.4 s** raw (~405 s normalized) |
| **per valid submission** | **~1.8–2.0 s whole path; ~1.6 s simulation** (raw, 6 workers) |
| per valid submission, normalized (uncontended) | **~1.2 s whole path; ~1.0 s simulation** |
| speed-up vs the old JVM CircuitSim grader | **~11× whole path / ~12.6× simulation-only** |
| synthetic probe (`pipeline_100k_cycles`) | **13.2 Mevents/s** |
| `pipeline5`, 100k cycles | ~1.1 s |
| peak RSS | ~6 MB |
| tests | 247 core + 14 CLI + 9 golden |

The old grader (measured over all 357, normalized) is **4481 s / ~74.7 min**, i.e. ~13 s per
submission; we are ~11× faster end-to-end. The M1 bar was "~3.4k components in <10 s in a
2 GB container" — we are ~10× under it. **~2 s per valid submission (often less) is
acceptable; this is not the bottleneck for grading.**

## What's already done (see `profiling.md` §7 for the details)

Word-wise trace hash (now opt-in), `floating_sweep` skip, monotone radix event queue,
evaluate-off-the-views, 32-byte `Copy` `Value` (single inline limb, width ≤ 64), dropped
`Arc<Value>`, `pending_val` in-place commit, queue `min_index` fast path. The harness now
converts + validates once per submission instead of once per program.

## Why the easy work is over

The profile (corpus-scale design, hash off) is dominated by: `apply` dispatch ~28%, the event
queue ~14%, the allocator ~14.5% (which we proved is **not** time — A and B below), per-event
`Vec`s ~6%, net resolve ~4%, clock bookkeeping ~6%. The remaining rows are either already
optimal (the radix queue is `O(1)` amortized) or sit on the two invariants we care about
(bit-determinism, corpus verdicts), so touching them costs a golden re-bless **and** a full
corpus run every time. Best-case micro work is ~1.15–1.25×.

## The substantial, higher-risk options

All of these are research projects. The engine is **event-count-bound**, so real gains mean
changing the *event model* — which is exactly what DESIGN.md pins. Every one is gated by:

1. **Golden re-bless** (`CSIM_BLESS=1 cargo test -p csim-core --release --test golden
   golden_traces_are_pinned -- --nocapture`, paste into `SCENARIOS`, record *why*) — the
   bit-determinism tripwire; and
2. **Corpus verdict-neutrality** (`corpus_bench.py --baseline …`, `moved: none`) — the
   behavioral oracle. Together these are the safety net that makes an event-model change
   checkable.

| project | expected | risk | effort |
|---|--:|---|---|
| **A** fold zero-delay deliveries into the net commit | 1.3–1.6× | high (reorders events) | high |
| **C** cache net resolution | 3–6% | medium | medium |
| **D** inline the behaviors / fixed output buffers | 3–8% | medium | high |
| **E** unify `compat` and production | 5–10% | **very high** (semantics) | medium |
| **B** levelize instead of event-per-change | unknown | **very high** (reverted once) | very high |
| **F** harness converter rewrite | ~2% of whole path | low | medium |

### A. Fold zero-delay per-sink deliveries into the net commit *(biggest)*

- **Idea.** With `wire.num = 0` (the shipped config) every sink's arrival equals the net
  transition's time, and a transition schedules **1 `Net` + S `Deliver` events** at one
  timestamp. `Deliver` is the largest event kind and the plurality of the stream. Apply the
  sink views and call `react` **inline in the `Net` arm** instead of scheduling S `Deliver`s —
  a fast path gated on `wire.num == 0`, keeping the general per-path path when wire delay is on
  (and for `compat`, whose per-sink value genuinely differs — see E).
- **Why big.** Attacks event count directly → the queue (~14%), the allocator (~14.5%), and
  `apply` dispatch (~28%) at once.
- **Why risky.** It **reorders** events: `Net` and its `Deliver`s are currently separate
  `(time, seq)` entries that interleave with other same-time events; folding runs them at the
  `Net` seq. Values can change if a same-time event touches the same parts.
- **De-risk.** Re-bless the goldens (documenting the reorder) and require an empty corpus
  verdict diff.
- **Expected.** ~1.3–1.6× on the engine (uncertain; the corpus is the judge).

### C. Cache net resolution (the safest of the substantial ones)

- **Idea.** `apply`'s `Fire` arm calls `resolve` per affected net — a `contention_merge` over
  drivers; maintain a per-net resolved value + dirty flag instead of recomputing.
- **Why.** `contention_merge_detail` is ~3.7%, plus the per-multi-driver `Vec<Value>`.
- **Why risky.** Cache invalidation correctness (medium).
- **Expected.** ~3–6%.

### D. Inline the behaviors / fixed output buffers

- **Idea.** `Behavior::eval_with` is a big match returning a fresh `Vec<Value>` per evaluation
  (the counting allocator showed ~10 allocs/event). Write outputs into a caller-owned inline
  buffer and/or inline the common gates into `apply`.
- **Why.** Removes the per-eval allocation and some indirect dispatch.
- **Why risky.** Wide, mechanical diff (≈45 output sites); and note **allocation reduction is
  only ~1% of time** — the win here is dispatch, not the allocs.
- **Expected.** ~3–8%.

### E. Unify `compat` and production *(a product decision, not a patch)*

- **Idea.** `compat` is what the corpus/grading uses, and its per-sink `getIncomingValue`
  merge is expensive (we measured the slow path taken **~6:1** because receivers are often
  drivers themselves or on subcircuit-bounded nets). Production is cheaper but stricter.
  The docs carry an open product question: **should production read a floating `sel` as CE does
  (all-`Z`, inert) instead of halting?** If yes, `compat` could be retired and the cheap
  production delivery path becomes the only one.
- **Why big.** Removes the 6:1 slow path.
- **Why risky.** It changes the `X` rule the whole engine is built around — a **semantic/verdict
  change** that needs human sign-off and the corpus as the oracle.
- **Expected.** ~5–10%, correctness-first.

### B. Levelize instead of event-per-change (the reverted `settle-engine`)

- **Idea.** A levelized, activity-swept fixed-point engine (Kahn order + residue iteration),
  no event queue.
- **Why risky.** A **different value model** (no time). It was built, reverted, and does *not*
  fix CE fidelity; reverses DESIGN.md §4.2's "one delay-aware engine" decision. Not worth
  reopening without a course-level reason.

### F. Harness converter

The `.sim → .csx` round-trip is ~23 s of a ~619 s path (~4%); a faster converter is the
transpiler's domain and bounded by ~4%. Low risk, small ceiling.

## Recommendation

**Park it.** With the trace hash opt-in, the engine and harness are ~11× the old grader and
~10× under budget; none of the above is worth the risk for the marginal gains at course scale.
If more is ever genuinely needed, do **A** (with both gates green) or, if you want a safe
bounded follow-up, **C**.
