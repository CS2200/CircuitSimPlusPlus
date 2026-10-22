//! Arbitrary-width four-state logic values (DESIGN.md §4.1; BACKEND.md task B1).
//!
//! A [`Value`] is `width` bits, each in one of four states: `0`, `1`,
//! `X` (unknown/contention), or `Z` (undriven/floating). The representation
//! is three machine-word masks — `ones`, `xs`, `zs` — exactly matching the
//! `{v, x, z}` hex-mask encoding pinned in `docs/ipc.md` §1: a bit set in
//! `ones` is a logic 1, in `xs` an X, in `zs` a Z, and clear in all three a
//! logic 0.
//!
//! Two invariants hold for every `Value`:
//!
//! * **Disjointness** — at most one mask has a given bit set.
//! * **Canonical form** — bits beyond `width` are always clear.
//!
//! Every constructor and operation maintains both, so `==` is meaningful.
//!
//! ## Semantics notes
//!
//! * Gate operations ([`Value::and`], [`Value::or`], [`Value::xor`],
//!   [`Value::not`], [`Value::mux`]) treat an input `Z` as `X`. This is
//!   purely defensive: per DESIGN.md §4.1, *consuming* a floating value is a
//!   simulation-halting error, and the engines halt before a `Z` ever
//!   reaches a gate input (task B4). Gate outputs are always driven, so
//!   gate ops never produce `Z`.
//! * [`Value::contention_merge`] is the net-resolution function: it resolves
//!   any number of drivers onto one net per §4.1 (no enabled drivers → `Z`;
//!   disagreement → `X`).
//!
//! Internally a value is `Vec<u64>` limbs, little-endian (limb 0 holds bits
//! 0..64). Widths ≤ 64 bits — the overwhelming majority at course scale —
//! are single-limb; if M5 profiling justifies it, an inline-small-limb
//! representation can replace `Vec` behind this API without touching
//! callers.

use std::cmp::Ordering;
use std::fmt;

use crate::api::WireValue;

const LIMB_BITS: u32 = 64;

/// A single four-state bit (DESIGN.md §4.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bit {
    /// Logic 0.
    Zero,
    /// Logic 1.
    One,
    /// Unknown / contention.
    X,
    /// Undriven / floating (high-impedance).
    Z,
}

impl fmt::Display for Bit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let c = match self {
            Bit::Zero => '0',
            Bit::One => '1',
            Bit::X => 'x',
            Bit::Z => 'z',
        };
        write!(f, "{c}")
    }
}

/// Errors produced when parsing external value representations (hex masks
/// from the frontend / CLI). Engine-internal misuse (width mismatches)
/// panics instead — that is a bug in csim-core, not bad user input.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValueError {
    /// A mask string contains a non-hex-digit character.
    #[error("invalid hex digit in mask {mask:?}")]
    InvalidHex {
        /// The offending mask string.
        mask: String,
    },
    /// A mask's value does not fit in the requested bit width.
    #[error("mask {mask:?} does not fit in {width} bits")]
    MaskTooWide {
        /// The offending mask string.
        mask: String,
        /// The width (bits) the mask was parsed into.
        width: u32,
    },
    /// The v/x/z masks set the same bit in more than one mask.
    #[error("value masks overlap: a bit is set in more than one of v/x/z")]
    OverlappingMasks,
}

/// An arbitrary-width four-state logic vector. See module docs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Value {
    width: u32,
    ones: Limbs,
    xs: Limbs,
    zs: Limbs,
}

/// Limb storage: one inline limb for width ≤ 64 (the universal case —
/// `MAX_BITSIZE` is 32 and multiplier outputs are 64), heap Vec beyond
/// (the API stays arbitrary-width). Engine hot paths clone `Value`s
/// constantly; the inline case makes those clones allocation-free
/// (callgrind on the delay engine showed malloc+free ≈ 30% of runtime,
/// task B10).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Limbs {
    Inline(u64),
    Heap(Vec<u64>),
}

impl Limbs {
    /// `n` zero limbs, inline when possible. (`Inline` is exactly one
    /// limb — a 0-limb slice, for 0-width values, must stay a Vec.)
    fn zeroed(n: usize) -> Limbs {
        if n == 1 {
            Limbs::Inline(0)
        } else {
            Limbs::Heap(vec![0; n])
        }
    }

    /// Wrap an existing limb vector (inline when it fits).
    fn from_vec(v: Vec<u64>) -> Limbs {
        if v.len() == 1 {
            Limbs::Inline(v[0])
        } else {
            Limbs::Heap(v)
        }
    }
}

impl std::ops::Deref for Limbs {
    type Target = [u64];
    fn deref(&self) -> &[u64] {
        match self {
            Limbs::Inline(limb) => std::slice::from_ref(limb),
            Limbs::Heap(v) => v,
        }
    }
}

impl std::ops::DerefMut for Limbs {
    fn deref_mut(&mut self) -> &mut [u64] {
        match self {
            Limbs::Inline(limb) => std::slice::from_mut(limb),
            Limbs::Heap(v) => v,
        }
    }
}

fn n_limbs(width: u32) -> usize {
    (width as usize).div_ceil(LIMB_BITS as usize)
}

/// Mask of the valid bits in the most significant limb of a `width`-bit
/// value (`u64::MAX` when `width` is a whole number of limbs).
fn top_mask(width: u32) -> u64 {
    match width % LIMB_BITS {
        0 => u64::MAX,
        r => (1u64 << r) - 1,
    }
}

/// Mask of the valid bits in limb `i` of a `width`-bit value.
fn limb_mask(width: u32, i: usize) -> u64 {
    if i + 1 == n_limbs(width) {
        top_mask(width)
    } else {
        u64::MAX
    }
}

/// `src >> n`, keeping `dst_limbs` limbs of the result.
fn shr_bits(src: &[u64], n: u32, dst_limbs: usize) -> Vec<u64> {
    let limb_shift = (n / LIMB_BITS) as usize;
    let bit_shift = n % LIMB_BITS;
    let mut out = vec![0u64; dst_limbs];
    for (i, slot) in out.iter_mut().enumerate() {
        let s = i + limb_shift;
        if s >= src.len() {
            break;
        }
        *slot = src[s] >> bit_shift;
        if bit_shift > 0 && s + 1 < src.len() {
            *slot |= src[s + 1] << (LIMB_BITS - bit_shift);
        }
    }
    out
}

/// `src << n`, keeping `dst_limbs` limbs of the result.
fn shl_bits(src: &[u64], n: u32, dst_limbs: usize) -> Vec<u64> {
    let limb_shift = (n / LIMB_BITS) as usize;
    let bit_shift = n % LIMB_BITS;
    let mut out = vec![0u64; dst_limbs];
    for (i, &limb) in src.iter().enumerate() {
        let d = i + limb_shift;
        if d >= dst_limbs {
            break;
        }
        out[d] |= limb << bit_shift;
        if bit_shift > 0 && d + 1 < dst_limbs {
            out[d + 1] |= limb >> (LIMB_BITS - bit_shift);
        }
    }
    out
}

/// Limb-wise `a + b + cin` → (sum limbs, carry-out). Result has `a.len()`
/// limbs; `b` may be shorter (treated as zero-padded).
fn limbs_add(a: &[u64], b: &[u64], cin: bool) -> (Vec<u64>, bool) {
    let mut out = Vec::with_capacity(a.len());
    let mut carry = u64::from(cin);
    for (i, &ai) in a.iter().enumerate() {
        let bi = b.get(i).copied().unwrap_or(0);
        let (s, c1) = ai.overflowing_add(bi);
        let (s, c2) = s.overflowing_add(carry);
        carry = u64::from(c1 || c2);
        out.push(s);
    }
    (out, carry != 0)
}

/// Limb-wise `a - b - bin` → (difference limbs mod 2^(64·len), borrow-out).
fn limbs_sub(a: &[u64], b: &[u64], bin: bool) -> (Vec<u64>, bool) {
    let mut out = Vec::with_capacity(a.len());
    let mut borrow = bin;
    for (i, &ai) in a.iter().enumerate() {
        let bi = b.get(i).copied().unwrap_or(0);
        let (d, b1) = ai.overflowing_sub(bi);
        let (d, b2) = d.overflowing_sub(u64::from(borrow));
        borrow = b1 || b2;
        out.push(d);
    }
    (out, borrow)
}

/// Limb-wise unsigned comparison, most-significant limb first.
fn limbs_cmp(a: &[u64], b: &[u64]) -> Ordering {
    for i in (0..a.len().max(b.len())).rev() {
        let ai = a.get(i).copied().unwrap_or(0);
        let bi = b.get(i).copied().unwrap_or(0);
        match ai.cmp(&bi) {
            Ordering::Equal => {}
            ord => return ord,
        }
    }
    Ordering::Equal
}

/// Canonical hex rendering of a mask: empty string when zero (per
/// `docs/ipc.md` §1), otherwise lowercase hex with no leading zeros.
fn mask_to_hex(mask: &[u64]) -> String {
    match mask.iter().rposition(|&l| l != 0) {
        None => String::new(),
        Some(top) => {
            let mut s = format!("{:x}", mask[top]);
            for i in (0..top).rev() {
                s.push_str(&format!("{:016x}", mask[i]));
            }
            s
        }
    }
}

fn hex_digit(c: u8) -> Option<u64> {
    match c {
        b'0'..=b'9' => Some(u64::from(c - b'0')),
        b'a'..=b'f' => Some(u64::from(c - b'a' + 10)),
        b'A'..=b'F' => Some(u64::from(c - b'A' + 10)),
        _ => None,
    }
}

/// Parse a big-endian hex mask into `n_limbs(width)` limbs. Leading zeros
/// are tolerated; a *nonzero* bit at or beyond `width` is an error.
fn parse_hex_mask(s: &str, width: u32) -> Result<Vec<u64>, ValueError> {
    let n = n_limbs(width);
    let mut limbs = vec![0u64; n];
    let mut limb = 0usize;
    let mut shift = 0u32;
    for &c in s.as_bytes().iter().rev() {
        let d = hex_digit(c).ok_or_else(|| ValueError::InvalidHex { mask: s.to_owned() })?;
        if limb >= n {
            // Past capacity: only insignificant leading zeros are allowed.
            if d != 0 {
                return Err(ValueError::MaskTooWide {
                    mask: s.to_owned(),
                    width,
                });
            }
            continue;
        }
        limbs[limb] |= d << shift;
        shift += 4;
        if shift == LIMB_BITS {
            shift = 0;
            limb += 1;
        }
    }
    if n > 0 && limbs[n - 1] & !top_mask(width) != 0 {
        return Err(ValueError::MaskTooWide {
            mask: s.to_owned(),
            width,
        });
    }
    Ok(limbs)
}

impl Value {
    /// All bits logic 0.
    pub fn zero(width: u32) -> Self {
        Value {
            width,
            ones: Limbs::zeroed(n_limbs(width)),
            xs: Limbs::zeroed(n_limbs(width)),
            zs: Limbs::zeroed(n_limbs(width)),
        }
    }

    /// All bits logic 1.
    pub fn all_ones(width: u32) -> Self {
        let mut v = Self::zero(width);
        v.ones.fill(u64::MAX);
        v.normalize();
        v
    }

    /// All bits X.
    pub fn x(width: u32) -> Self {
        let mut v = Self::zero(width);
        v.xs.fill(u64::MAX);
        v.normalize();
        v
    }

    /// All bits Z (fully undriven).
    pub fn z(width: u32) -> Self {
        let mut v = Self::zero(width);
        v.zs.fill(u64::MAX);
        v.normalize();
        v
    }

    /// A known constant. Panics if `v` does not fit in `width` bits.
    pub fn from_u64(width: u32, v: u64) -> Self {
        if width < LIMB_BITS {
            assert!(
                v >> width == 0,
                "from_u64: {v:#x} does not fit in {width} bits"
            );
        }
        let mut val = Self::zero(width);
        if let Some(first) = val.ones.first_mut() {
            *first = v;
        }
        val.normalize();
        val
    }

    /// Build from per-bit states, `bits[0]` = least significant.
    pub fn from_bits(bits: &[Bit]) -> Self {
        let mut v = Self::zero(bits.len() as u32);
        for (i, b) in bits.iter().enumerate() {
            let m = 1u64 << (i as u32 % LIMB_BITS);
            let limb = i / LIMB_BITS as usize;
            match b {
                Bit::One => v.ones[limb] |= m,
                Bit::X => v.xs[limb] |= m,
                Bit::Z => v.zs[limb] |= m,
                Bit::Zero => {}
            }
        }
        v
    }

    /// Build a known (no X/Z) value from raw `ones` limbs; extra limbs are
    /// truncated and missing limbs zero-filled. Internal use.
    fn from_limbs(width: u32, mut ones: Vec<u64>) -> Value {
        ones.resize(n_limbs(width), 0);
        ones.truncate(n_limbs(width));
        let mut v = Value {
            width,
            ones: Limbs::from_vec(ones),
            xs: Limbs::zeroed(n_limbs(width)),
            zs: Limbs::zeroed(n_limbs(width)),
        };
        v.normalize();
        v
    }

    /// Re-mask the top limb (restore canonical form after raw writes).
    fn normalize(&mut self) {
        if self.ones.is_empty() {
            return;
        }
        let m = top_mask(self.width);
        let last = self.ones.len() - 1;
        self.ones[last] &= m;
        self.xs[last] &= m;
        self.zs[last] &= m;
    }

    /// Number of bits in the vector.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Any bit X?
    pub fn has_x(&self) -> bool {
        self.xs.iter().any(|&l| l != 0)
    }

    /// Any bit Z?
    pub fn has_z(&self) -> bool {
        self.zs.iter().any(|&l| l != 0)
    }

    /// Every bit a known 0 or 1 (no X, no Z)?
    pub fn is_fully_known(&self) -> bool {
        !self.has_x() && !self.has_z()
    }

    /// Every bit Z (nothing driven at all)?
    pub fn is_fully_z(&self) -> bool {
        self.zs
            .iter()
            .enumerate()
            .all(|(i, &l)| l == limb_mask(self.width, i))
    }

    /// State of bit `i` (0 = least significant).
    pub fn bit(&self, i: u32) -> Bit {
        assert!(i < self.width, "bit: index {i} out of width {}", self.width);
        let limb = (i / LIMB_BITS) as usize;
        let m = 1u64 << (i % LIMB_BITS);
        if self.ones[limb] & m != 0 {
            Bit::One
        } else if self.xs[limb] & m != 0 {
            Bit::X
        } else if self.zs[limb] & m != 0 {
            Bit::Z
        } else {
            Bit::Zero
        }
    }

    /// The value as a `u64`, if it fits and is fully known.
    pub fn to_u64(&self) -> Option<u64> {
        if self.width > LIMB_BITS || !self.is_fully_known() {
            return None;
        }
        Some(if self.ones.is_empty() {
            0
        } else {
            self.ones[0] & top_mask(self.width)
        })
    }

    // ---- Gate operations (4-state; input Z treated as X; never output Z)

    /// Shared limb loop for two-input gates. `f` maps
    /// `(ones_a, bad_a, ones_b, bad_b, mask)` → `(ones_out, xs_out)`, where
    /// `bad` = `xs | zs` (unknown-or-floating input bits, both treated as
    /// unknown at a gate input).
    fn gate_binop(
        &self,
        rhs: &Value,
        op: &str,
        f: impl Fn(u64, u64, u64, u64, u64) -> (u64, u64),
    ) -> Value {
        assert_eq!(
            self.width, rhs.width,
            "{op}: width mismatch ({} vs {})",
            self.width, rhs.width
        );
        let n = n_limbs(self.width);
        let mut ones = vec![0u64; n];
        let mut xs = vec![0u64; n];
        for i in 0..n {
            let bad_a = self.xs[i] | self.zs[i];
            let bad_b = rhs.xs[i] | rhs.zs[i];
            let mask = limb_mask(self.width, i);
            let (o, x) = f(self.ones[i], bad_a, rhs.ones[i], bad_b, mask);
            ones[i] = o;
            xs[i] = x;
        }
        Value {
            width: self.width,
            ones: Limbs::from_vec(ones),
            xs: Limbs::from_vec(xs),
            zs: Limbs::zeroed(n),
        }
    }

    /// 4-state AND: `0 ∧ _ = 0`; `1 ∧ 1 = 1`; otherwise X.
    pub fn and(&self, rhs: &Value) -> Value {
        self.gate_binop(rhs, "and", |oa, ba, ob, bb, mask| {
            let zero_a = !(oa | ba) & mask;
            let zero_b = !(ob | bb) & mask;
            let o = oa & ob;
            let x = mask & !(o | zero_a | zero_b);
            (o, x)
        })
    }

    /// 4-state OR: `1 ∨ _ = 1`; `0 ∨ 0 = 0`; otherwise X.
    pub fn or(&self, rhs: &Value) -> Value {
        self.gate_binop(rhs, "or", |oa, ba, ob, bb, mask| {
            let zero_a = !(oa | ba) & mask;
            let zero_b = !(ob | bb) & mask;
            let o = oa | ob;
            let x = mask & !(o | (zero_a & zero_b));
            (o, x)
        })
    }

    /// 4-state XOR: X if either input unknown, else bitwise xor.
    pub fn xor(&self, rhs: &Value) -> Value {
        self.gate_binop(rhs, "xor", |oa, ba, ob, bb, mask| {
            let bad = (ba | bb) & mask;
            ((oa ^ ob) & !bad & mask, bad)
        })
    }

    /// 4-state NOT: `¬0 = 1`; `¬1 = 0`; `¬X = ¬Z = X`.
    pub fn not(&self) -> Value {
        let n = n_limbs(self.width);
        let mut ones = vec![0u64; n];
        let mut xs = vec![0u64; n];
        for i in 0..n {
            let bad = self.xs[i] | self.zs[i];
            let mask = limb_mask(self.width, i);
            ones[i] = !self.ones[i] & !bad & mask;
            xs[i] = bad & mask;
        }
        Value {
            width: self.width,
            ones: Limbs::from_vec(ones),
            xs: Limbs::from_vec(xs),
            zs: Limbs::zeroed(n),
        }
    }

    /// Two-input mux: `sel` = 1 selects `d1`, `sel` = 0 selects `d0`.
    /// If `sel` is unknown, bits where `d1` and `d0` agree pass through
    /// (preserving strength — two agreeing Z inputs stay Z) and disagreeing
    /// bits become X.
    pub fn mux(sel: &Value, d1: &Value, d0: &Value) -> Value {
        assert_eq!(sel.width, 1, "mux: select must be 1 bit, got {}", sel.width);
        assert_eq!(
            d1.width, d0.width,
            "mux: data width mismatch ({} vs {})",
            d1.width, d0.width
        );
        match sel.bit(0) {
            Bit::One => d1.clone(),
            Bit::Zero => d0.clone(),
            Bit::X | Bit::Z => {
                let n = n_limbs(d1.width);
                let mut ones = vec![0u64; n];
                let mut xs = vec![0u64; n];
                let mut zs = vec![0u64; n];
                for i in 0..n {
                    let mask = limb_mask(d1.width, i);
                    let zero1 = !(d1.ones[i] | d1.xs[i] | d1.zs[i]) & mask;
                    let zero0 = !(d0.ones[i] | d0.xs[i] | d0.zs[i]) & mask;
                    let agree = (d1.ones[i] & d0.ones[i])
                        | (zero1 & zero0)
                        | (d1.xs[i] & d0.xs[i])
                        | (d1.zs[i] & d0.zs[i]);
                    ones[i] = d1.ones[i] & d0.ones[i];
                    xs[i] = (d1.xs[i] & d0.xs[i]) | (!agree & mask);
                    zs[i] = d1.zs[i] & d0.zs[i];
                }
                Value {
                    width: d1.width,
                    ones: Limbs::from_vec(ones),
                    xs: Limbs::from_vec(xs),
                    zs: Limbs::from_vec(zs),
                }
            }
        }
    }

    /// Net resolution (DESIGN.md §4.1): combine every driver of one net.
    pub fn contention_merge(width: u32, drivers: &[Value]) -> Value {
        Self::contention_merge_detail(width, drivers).0
    }

    /// As [`Self::contention_merge`], and also reports whether any bit's `X`
    /// came from a genuine **driver disagreement** — two enabled drivers
    /// fighting, i.e. a short circuit — rather than from a driver that was
    /// *already* `X`. The UI says "short circuit" for the former and stays
    /// quiet for the latter (an `X` from a divide-by-zero or an `X` mux select
    /// simply flows in).
    ///
    /// Per bit, over all drivers: no driving driver → Z; one state
    /// unanimously → that state; any disagreement (or any driven X) → X.
    /// A driver bit that is Z is *not driving* that bit.
    pub fn contention_merge_detail(width: u32, drivers: &[Value]) -> (Value, bool) {
        for d in drivers {
            assert_eq!(
                d.width, width,
                "contention_merge: driver width {} != net width {width}",
                d.width
            );
        }
        if drivers.is_empty() {
            return (Value::z(width), false);
        }
        let n = n_limbs(width);
        let mut ones = vec![0u64; n];
        let mut xs = vec![0u64; n];
        let mut zs = vec![0u64; n];
        let mut shorted = false;
        for i in 0..n {
            let mask = limb_mask(width, i);
            let mut any_driven = 0u64; // some driver drives this bit (0/1/X)
            let mut any_one = 0u64; // some driver drives it to 1
            let mut all_one_or_z = u64::MAX; // every driver says 1 or Z
            let mut any_x = 0u64; // some driver drives X
            for d in drivers {
                any_driven |= !d.zs[i];
                any_one |= d.ones[i];
                any_x |= d.xs[i];
                all_one_or_z &= d.ones[i] | d.zs[i];
            }
            let disagree = any_one & !all_one_or_z;
            if disagree & mask != 0 {
                shorted = true;
            }
            let x = (any_x | disagree) & mask;
            ones[i] = all_one_or_z & any_driven & !x & mask;
            xs[i] = x;
            zs[i] = !any_driven & mask;
        }
        (
            Value {
                width,
                ones: Limbs::from_vec(ones),
                xs: Limbs::from_vec(xs),
                zs: Limbs::from_vec(zs),
            },
            shorted,
        )
    }

    // ---- Width operations

    /// Bits `offset .. offset+width` as a new value.
    pub fn extract(&self, offset: u32, width: u32) -> Value {
        assert!(
            u64::from(offset) + u64::from(width) <= u64::from(self.width),
            "extract: [{offset}..+{width}] out of {}-bit value",
            self.width
        );
        let n = n_limbs(width);
        let mut v = Value {
            width,
            ones: Limbs::from_vec(shr_bits(&self.ones, offset, n)),
            xs: Limbs::from_vec(shr_bits(&self.xs, offset, n)),
            zs: Limbs::from_vec(shr_bits(&self.zs, offset, n)),
        };
        v.normalize();
        v
    }

    /// `upper` in the high bits, `lower` in the low bits.
    pub fn concat(upper: &Value, lower: &Value) -> Value {
        let width = upper.width + lower.width;
        let n = n_limbs(width);
        let shift = lower.width;
        let mut ones = shl_bits(&upper.ones, shift, n);
        let mut xs = shl_bits(&upper.xs, shift, n);
        let mut zs = shl_bits(&upper.zs, shift, n);
        for (i, &l) in lower.ones.iter().enumerate() {
            ones[i] |= l;
        }
        for (i, &l) in lower.xs.iter().enumerate() {
            xs[i] |= l;
        }
        for (i, &l) in lower.zs.iter().enumerate() {
            zs[i] |= l;
        }
        let mut v = Value {
            width,
            ones: Limbs::from_vec(ones),
            xs: Limbs::from_vec(xs),
            zs: Limbs::from_vec(zs),
        };
        v.normalize();
        v
    }

    /// Grow to `width` bits, filling with 0.
    pub fn zero_extend(&self, width: u32) -> Value {
        assert!(
            width >= self.width,
            "zero_extend: {} -> {width} shrinks",
            self.width
        );
        let n = n_limbs(width);
        let grow = |m: &[u64]| {
            let mut v = m.to_vec();
            v.resize(n, 0);
            v
        };
        Value {
            width,
            ones: Limbs::from_vec(grow(&self.ones)),
            xs: Limbs::from_vec(grow(&self.xs)),
            zs: Limbs::from_vec(grow(&self.zs)),
        }
    }

    /// Grow to `width` bits, replicating the sign bit's state (a sign bit of
    /// X extends with X, Z with Z).
    pub fn sign_extend(&self, width: u32) -> Value {
        assert!(
            width >= self.width,
            "sign_extend: {} -> {width} shrinks",
            self.width
        );
        assert!(self.width >= 1, "sign_extend: 0-bit value has no sign");
        if width == self.width {
            return self.clone();
        }
        let ext = width - self.width;
        let fill = match self.bit(self.width - 1) {
            Bit::One => Value::all_ones(ext),
            Bit::Zero => Value::zero(ext),
            Bit::X => Value::x(ext),
            Bit::Z => Value::z(ext),
        };
        Value::concat(&fill, self)
    }

    /// Keep the low `width` bits.
    pub fn truncate(&self, width: u32) -> Value {
        assert!(width <= self.width, "truncate: {width} > {}", self.width);
        self.extract(0, width)
    }

    // ---- Arithmetic (DESIGN.md §6; task B4)
    //
    // Uniform unknown-value rule: if *any* input bit is X or Z, every
    // output bit is X (each output bit depends on at least one input bit,
    // and for carry chains typically on many). Consuming Z is a
    // simulation-halting error at the behavior level (§4.1), so a Z here
    // is defensive only — the engines halt first.

    /// `self + rhs + cin` → (`sum` mod 2^width, carry-out as a 1-bit value).
    pub fn add(&self, rhs: &Value, cin: bool) -> (Value, Value) {
        assert_eq!(self.width, rhs.width, "add: width mismatch");
        if !self.is_fully_known() || !rhs.is_fully_known() {
            return (Value::x(self.width), Value::x(1));
        }
        // Compute with one extra limb of headroom so the carry-out at the
        // *value* width (not the limb width) is observable: the full sum
        // is < 2^(width+1), so bit `width` of the result is the carry.
        let n = n_limbs(self.width + 1);
        let (mut a, mut b) = (self.ones.to_vec(), rhs.ones.to_vec());
        a.resize(n, 0);
        b.resize(n, 0);
        let (sum, _) = limbs_add(&a, &b, cin);
        let carry = (sum[(self.width / LIMB_BITS) as usize] >> (self.width % LIMB_BITS)) & 1;
        (
            Value::from_limbs(self.width, sum),
            Value::from_u64(1, carry),
        )
    }

    /// `self - rhs - bin` → (difference mod 2^width, borrow-out 1-bit).
    pub fn sub(&self, rhs: &Value, bin: bool) -> (Value, Value) {
        assert_eq!(self.width, rhs.width, "sub: width mismatch");
        if !self.is_fully_known() || !rhs.is_fully_known() {
            return (Value::x(self.width), Value::x(1));
        }
        // Same headroom trick as `add`: bit `width` of the full
        // difference (mod 2^(width+1)) is the borrow-out.
        let n = n_limbs(self.width + 1);
        let (mut a, mut b) = (self.ones.to_vec(), rhs.ones.to_vec());
        a.resize(n, 0);
        b.resize(n, 0);
        let (diff, _) = limbs_sub(&a, &b, bin);
        let borrow = (diff[(self.width / LIMB_BITS) as usize] >> (self.width % LIMB_BITS)) & 1;
        (
            Value::from_limbs(self.width, diff),
            Value::from_u64(1, borrow),
        )
    }

    /// `self * rhs` → product of width `2 * width` (no truncation).
    pub fn mul(&self, rhs: &Value) -> Value {
        assert_eq!(self.width, rhs.width, "mul: width mismatch");
        let out_w = 2 * self.width;
        if !self.is_fully_known() || !rhs.is_fully_known() {
            return Value::x(out_w);
        }
        let n = n_limbs(out_w);
        let mut acc = vec![0u64; n];
        for i in 0..self.width {
            if (rhs.ones[(i / LIMB_BITS) as usize] >> (i % LIMB_BITS)) & 1 == 1 {
                let shifted = shl_bits(&self.ones, i, n);
                // Carry-out is impossible: product < 2^(2w).
                acc = limbs_add(&acc, &shifted, false).0;
            }
        }
        Value::from_limbs(out_w, acc)
    }

    /// `self / rhs` → (quotient, remainder), unsigned; `None` when `rhs`
    /// is zero (the caller decides what divide-by-zero means — the
    /// divider component maps it to `X`).
    pub fn div_rem(&self, rhs: &Value) -> Option<(Value, Value)> {
        assert_eq!(self.width, rhs.width, "div_rem: width mismatch");
        if !self.is_fully_known() || !rhs.is_fully_known() {
            return Some((Value::x(self.width), Value::x(self.width)));
        }
        if rhs.ones.iter().all(|&l| l == 0) {
            return None;
        }
        let n = n_limbs(self.width);
        let mut rem = vec![0u64; n];
        let mut quot = vec![0u64; n];
        // Restoring long division, MSB first. `rem` stays < rhs after each
        // subtraction, so it fits in `width` bits; the shift-in may set
        // conceptual bit `width` (tracked as `spill`), which forces the
        // subtraction and is cancelled by its borrow-out.
        for i in (0..self.width).rev() {
            let bit = (self.ones[(i / LIMB_BITS) as usize] >> (i % LIMB_BITS)) & 1;
            let mut carry = bit;
            for l in rem.iter_mut() {
                let nc = *l >> 63;
                *l = (*l << 1) | carry;
                carry = nc;
            }
            let spill = carry != 0;
            if spill || limbs_cmp(&rem, &rhs.ones) != Ordering::Less {
                rem = limbs_sub(&rem, &rhs.ones, false).0;
                quot[(i / LIMB_BITS) as usize] |= 1 << (i % LIMB_BITS);
            }
        }
        Some((
            Value::from_limbs(self.width, quot),
            Value::from_limbs(self.width, rem),
        ))
    }

    /// Two's-complement negation (`0 - self`).
    pub fn neg(&self) -> Value {
        Value::zero(self.width).sub(self, false).0
    }

    /// Unsigned three-way comparison; `None` on unknown inputs.
    /// (Named `compare` to avoid confusion with `Ord::cmp`.)
    pub fn compare(&self, rhs: &Value) -> Option<Ordering> {
        assert_eq!(self.width, rhs.width, "compare: width mismatch");
        if !self.is_fully_known() || !rhs.is_fully_known() {
            return None;
        }
        Some(limbs_cmp(&self.ones, &rhs.ones))
    }

    /// Shift left logical by `n` (≥ width → 0).
    pub fn shl(&self, n: u32) -> Value {
        if !self.is_fully_known() {
            return Value::x(self.width);
        }
        Value::from_limbs(self.width, shl_bits(&self.ones, n, n_limbs(self.width)))
    }

    /// Shift right logical by `n` (≥ width → 0).
    pub fn shr(&self, n: u32) -> Value {
        if !self.is_fully_known() {
            return Value::x(self.width);
        }
        Value::from_limbs(self.width, shr_bits(&self.ones, n, n_limbs(self.width)))
    }

    /// Shift right arithmetic by `n`, replicating the sign bit
    /// (≥ width → all-sign-bits).
    pub fn sar(&self, n: u32) -> Value {
        if !self.is_fully_known() {
            return Value::x(self.width);
        }
        let mut out = shr_bits(&self.ones, n, n_limbs(self.width));
        if self.bit(self.width - 1) == Bit::One {
            let keep = self.width.saturating_sub(n); // bits that survive
            for i in keep..self.width {
                out[(i / LIMB_BITS) as usize] |= 1 << (i % LIMB_BITS);
            }
        }
        Value::from_limbs(self.width, out)
    }

    /// Rotate left by `n mod width`.
    pub fn rotl(&self, n: u32) -> Value {
        if !self.is_fully_known() {
            return Value::x(self.width);
        }
        let n = n % self.width;
        let (l, r) = (self.shl(n), self.shr(self.width - n));
        Value::from_limbs(
            self.width,
            l.ones
                .iter()
                .zip(r.ones.iter())
                .map(|(a, b)| a | b)
                .collect(),
        )
    }

    /// Rotate right by `n mod width`.
    pub fn rotr(&self, n: u32) -> Value {
        if !self.is_fully_known() {
            return Value::x(self.width);
        }
        let n = n % self.width;
        let (l, r) = (self.shr(n), self.shl(self.width - n));
        Value::from_limbs(
            self.width,
            l.ones
                .iter()
                .zip(r.ones.iter())
                .map(|(a, b)| a | b)
                .collect(),
        )
    }

    // ---- External representations

    /// Encode as the IPC `{v, x, z}` hex masks (`docs/ipc.md` §1).
    pub fn to_wire_value(&self) -> WireValue {
        WireValue {
            v: mask_to_hex(&self.ones),
            x: mask_to_hex(&self.xs),
            z: mask_to_hex(&self.zs),
        }
    }

    /// Decode IPC hex masks for a `width`-bit value. Validates hex syntax,
    /// fit-in-width, and mask disjointness.
    pub fn from_wire_value(wv: &WireValue, width: u32) -> Result<Value, ValueError> {
        Self::from_hex_masks(width, &wv.v, &wv.x, &wv.z)
    }

    /// Decode raw hex masks (same rules as [`Value::from_wire_value`]).
    pub fn from_hex_masks(width: u32, v: &str, x: &str, z: &str) -> Result<Value, ValueError> {
        let ones = parse_hex_mask(v, width)?;
        let xs = parse_hex_mask(x, width)?;
        let zs = parse_hex_mask(z, width)?;
        for i in 0..n_limbs(width) {
            if (ones[i] & xs[i]) | (ones[i] & zs[i]) | (xs[i] & zs[i]) != 0 {
                return Err(ValueError::OverlappingMasks);
            }
        }
        Ok(Value {
            width,
            ones: Limbs::from_vec(ones),
            xs: Limbs::from_vec(xs),
            zs: Limbs::from_vec(zs),
        })
    }
}

/// Parse an integer literal in the grammar the assertion language uses: `0x…` hex,
/// `0b…` binary, anything else decimal. Returns `None` on a malformed literal, so a
/// caller can report it against the name it came from.
pub fn parse_int_literal(text: &str) -> Option<u64> {
    let t = text.trim();
    let (radix, digits) = if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X"))
    {
        (16, rest)
    } else if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        (2, rest)
    } else {
        (10, t)
    };
    if digits.is_empty() {
        return None;
    }
    u64::from_str_radix(digits, radix).ok()
}

impl fmt::Display for Value {
    /// Fully known values render as hex (`0x1fa3`); anything containing X
    /// or Z renders as an MSB-first bit string (`0b1x0z`).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_fully_known() {
            let h = mask_to_hex(&self.ones);
            write!(f, "0x{}", if h.is_empty() { "0" } else { &h })
        } else {
            write!(f, "0b")?;
            for i in (0..self.width).rev() {
                write!(f, "{}", self.bit(i))?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Bit; 4] = [Bit::Zero, Bit::One, Bit::X, Bit::Z];

    fn v1(b: Bit) -> Value {
        Value::from_bits(&[b])
    }

    fn bits(v: &Value) -> Vec<Bit> {
        (0..v.width()).map(|i| v.bit(i)).collect()
    }

    // ---- Arithmetic (task B4)

    fn k(width: u32, v: u64) -> Value {
        Value::from_u64(width, v)
    }

    #[test]
    fn add_carry_chain_across_limbs() {
        // 64-bit boundary carry: (2^64 - 1) + 1 = 2^64 in 128 bits.
        let (s, c) = k(128, u64::MAX).add(&k(128, 1), false);
        assert_eq!(s, Value::from_limbs(128, vec![0, 1]));
        assert_eq!(c, k(1, 0));
        // Carry out of the top.
        let (s, c) = k(4, 0b1111).add(&k(4, 0b1111), true);
        assert_eq!(s, k(4, 0b1111));
        assert_eq!(c, k(1, 1));
        // cin propagation.
        let (s, c) = k(8, 0).add(&k(8, 0), true);
        assert_eq!(s, k(8, 1));
        assert_eq!(c, k(1, 0));
    }

    #[test]
    fn sub_borrow() {
        let (d, b) = k(8, 10).sub(&k(8, 3), false);
        assert_eq!(d, k(8, 7));
        assert_eq!(b, k(1, 0));
        let (d, b) = k(8, 3).sub(&k(8, 10), false);
        assert_eq!(d, k(8, 249)); // 3 - 10 mod 256
        assert_eq!(b, k(1, 1));
        let (d, b) = k(8, 10).sub(&k(8, 10), true);
        assert_eq!(d, k(8, 255));
        assert_eq!(b, k(1, 1));
    }

    #[test]
    fn mul_double_width() {
        assert_eq!(k(16, 0xFFFF).mul(&k(16, 0xFFFF)), k(32, 0xFFFE_0001));
        assert_eq!(k(8, 0).mul(&k(8, 0xFF)), k(16, 0));
        // High-bit factors place bits above limb 0 of the result.
        assert_eq!(k(2, 0b10).mul(&k(2, 0b10)), k(4, 0b0100));
    }

    #[test]
    fn div_rem_incl_spill_and_zero() {
        let (q, r) = k(8, 100).div_rem(&k(8, 7)).unwrap();
        assert_eq!((q, r), (k(8, 14), k(8, 2)));
        // Dividend smaller than divisor.
        let (q, r) = k(8, 3).div_rem(&k(8, 200)).unwrap();
        assert_eq!((q, r), (k(8, 0), k(8, 3)));
        // Large divisor forces the rem shift spill path.
        let (q, r) = k(8, 255).div_rem(&k(8, 200)).unwrap();
        assert_eq!((q, r), (k(8, 1), k(8, 55)));
        // Divide by zero → None (component maps to X).
        assert!(k(8, 5).div_rem(&k(8, 0)).is_none());
        // Wide division across limbs: (2^64-1) / 3 = 0x5555...5555 r 0.
        let (q, r) = k(96, u64::MAX).div_rem(&k(96, 3)).unwrap();
        assert_eq!(
            (q, r),
            (Value::from_limbs(96, vec![u64::MAX / 3]), k(96, 0))
        );
    }

    #[test]
    fn neg_cmp() {
        assert_eq!(k(8, 1).neg(), k(8, 0xFF));
        assert_eq!(k(8, 0).neg(), k(8, 0));
        assert_eq!(k(8, 9).compare(&k(8, 10)), Some(Ordering::Less));
        assert_eq!(k(8, 10).compare(&k(8, 10)), Some(Ordering::Equal));
        assert_eq!(k(128, 0).compare(&k(128, 1)), Some(Ordering::Less));
        assert_eq!(Value::x(8).compare(&k(8, 1)), None);
    }

    #[test]
    fn shifts_and_rotates() {
        assert_eq!(k(8, 0b1000_0001).shl(1), k(8, 0b0000_0010));
        assert_eq!(k(8, 0b1000_0001).shr(1), k(8, 0b0100_0000));
        assert_eq!(k(8, 0b1000_0001).sar(1), k(8, 0b1100_0000));
        assert_eq!(k(8, 0b1000_0000).sar(9), k(8, 0xFF)); // n ≥ width
        assert_eq!(k(8, 0b0000_0001).shl(8), k(8, 0));
        assert_eq!(k(8, 0b1000_0001).rotl(1), k(8, 0b0000_0011));
        assert_eq!(k(8, 0b1000_0001).rotr(1), k(8, 0b1100_0000));
        assert_eq!(k(8, 0xAB).rotl(8), k(8, 0xAB)); // full turn
    }

    #[test]
    fn arithmetic_unknown_inputs_are_x() {
        for unk in [Value::x(8), Value::z(8)] {
            assert_eq!(unk.add(&k(8, 1), false).0, Value::x(8));
            assert_eq!(unk.sub(&k(8, 1), false).0, Value::x(8));
            assert_eq!(unk.mul(&k(8, 1)), Value::x(16));
            assert_eq!(unk.div_rem(&k(8, 1)).unwrap().0, Value::x(8));
            assert_eq!(unk.neg(), Value::x(8));
            assert_eq!(unk.shl(3), Value::x(8));
            assert_eq!(unk.sar(3), Value::x(8));
            assert_eq!(unk.rotl(3), Value::x(8));
        }
    }

    /// Both invariants, checked on everything the tests produce.
    fn assert_canonical(v: &Value) {
        assert_eq!(v.ones.len(), n_limbs(v.width), "limb count");
        assert_eq!(v.xs.len(), n_limbs(v.width), "limb count");
        assert_eq!(v.zs.len(), n_limbs(v.width), "limb count");
        for i in 0..v.ones.len() {
            assert_eq!(
                (v.ones[i] & v.xs[i]) | (v.ones[i] & v.zs[i]) | (v.xs[i] & v.zs[i]),
                0,
                "disjointness violated in limb {i}"
            );
        }
        if !v.ones.is_empty() {
            let m = top_mask(v.width);
            let last = v.ones.len() - 1;
            assert_eq!(v.ones[last] & !m, 0, "high ones bits set");
            assert_eq!(v.xs[last] & !m, 0, "high xs bits set");
            assert_eq!(v.zs[last] & !m, 0, "high zs bits set");
        }
    }

    // ---- Reference 4-state truth tables (gate inputs treat Z as X)

    fn and_ref(a: Bit, b: Bit) -> Bit {
        if a == Bit::Zero || b == Bit::Zero {
            Bit::Zero
        } else if a == Bit::One && b == Bit::One {
            Bit::One
        } else {
            Bit::X
        }
    }

    fn or_ref(a: Bit, b: Bit) -> Bit {
        if a == Bit::One || b == Bit::One {
            Bit::One
        } else if a == Bit::Zero && b == Bit::Zero {
            Bit::Zero
        } else {
            Bit::X
        }
    }

    fn xor_ref(a: Bit, b: Bit) -> Bit {
        match (a, b) {
            (Bit::Zero, Bit::Zero) | (Bit::One, Bit::One) => Bit::Zero,
            (Bit::Zero, Bit::One) | (Bit::One, Bit::Zero) => Bit::One,
            _ => Bit::X,
        }
    }

    fn not_ref(a: Bit) -> Bit {
        match a {
            Bit::Zero => Bit::One,
            Bit::One => Bit::Zero,
            _ => Bit::X,
        }
    }

    #[test]
    fn gate_truth_tables() {
        for a in ALL {
            assert_eq!(bits(&v1(a).not()), vec![not_ref(a)], "not {a:?}");
            for b in ALL {
                let and = v1(a).and(&v1(b));
                let or = v1(a).or(&v1(b));
                let xor = v1(a).xor(&v1(b));
                assert_eq!(bits(&and), vec![and_ref(a, b)], "{a:?} and {b:?}");
                assert_eq!(bits(&or), vec![or_ref(a, b)], "{a:?} or {b:?}");
                assert_eq!(bits(&xor), vec![xor_ref(a, b)], "{a:?} xor {b:?}");
                assert_canonical(&and);
                assert_canonical(&or);
                assert_canonical(&xor);
                // Gate outputs are always driven: never Z.
                assert!(!and.has_z() && !or.has_z() && !xor.has_z());
            }
        }
    }

    /// Gate ops must be limb-parallel: same truth tables at any width,
    /// including across limb boundaries.
    #[test]
    fn gate_ops_multibit_and_cross_limb() {
        let pat_a = [
            Bit::Zero,
            Bit::One,
            Bit::X,
            Bit::Z,
            Bit::One,
            Bit::Zero,
            Bit::Z,
            Bit::X,
        ];
        let pat_b = [
            Bit::One,
            Bit::X,
            Bit::Z,
            Bit::Zero,
            Bit::Zero,
            Bit::One,
            Bit::X,
            Bit::Z,
        ];
        // Repeat the 8-bit patterns to fill 1, 2, and 3 limbs (width 130).
        for width in [8usize, 64, 65, 130] {
            let a = Value::from_bits(
                &pat_a
                    .iter()
                    .cycle()
                    .take(width)
                    .copied()
                    .collect::<Vec<_>>(),
            );
            let b = Value::from_bits(
                &pat_b
                    .iter()
                    .cycle()
                    .take(width)
                    .copied()
                    .collect::<Vec<_>>(),
            );
            let and = a.and(&b);
            let or = a.or(&b);
            let xor = a.xor(&b);
            let not = a.not();
            for i in 0..width as u32 {
                let (ba, bb) = (a.bit(i), b.bit(i));
                assert_eq!(and.bit(i), and_ref(ba, bb), "and bit {i} width {width}");
                assert_eq!(or.bit(i), or_ref(ba, bb), "or bit {i} width {width}");
                assert_eq!(xor.bit(i), xor_ref(ba, bb), "xor bit {i} width {width}");
                assert_eq!(not.bit(i), not_ref(ba), "not bit {i} width {width}");
            }
            assert_canonical(&and);
            assert_canonical(&or);
            assert_canonical(&xor);
            assert_canonical(&not);
        }
    }

    #[test]
    fn mux_select() {
        let d1 = v1(Bit::One);
        let d0 = v1(Bit::Zero);
        assert_eq!(Value::mux(&v1(Bit::One), &d1, &d0), v1(Bit::One));
        assert_eq!(Value::mux(&v1(Bit::Zero), &d1, &d0), v1(Bit::Zero));

        // Unknown select: agreement passes through, disagreement -> X.
        for sel in [Bit::X, Bit::Z] {
            let s = v1(sel);
            assert_eq!(Value::mux(&s, &v1(Bit::One), &v1(Bit::Zero)), v1(Bit::X));
            assert_eq!(Value::mux(&s, &v1(Bit::One), &v1(Bit::One)), v1(Bit::One));
            assert_eq!(
                Value::mux(&s, &v1(Bit::Zero), &v1(Bit::Zero)),
                v1(Bit::Zero)
            );
            assert_eq!(Value::mux(&s, &v1(Bit::X), &v1(Bit::X)), v1(Bit::X));
            assert_eq!(Value::mux(&s, &v1(Bit::Z), &v1(Bit::Z)), v1(Bit::Z));
            assert_eq!(Value::mux(&s, &v1(Bit::X), &v1(Bit::One)), v1(Bit::X));
            assert_eq!(Value::mux(&s, &v1(Bit::Z), &v1(Bit::Zero)), v1(Bit::X));
        }

        // Multi-bit data under unknown select.
        let d1 = Value::from_bits(&[Bit::One, Bit::Zero, Bit::X, Bit::Z]);
        let d0 = Value::from_bits(&[Bit::Zero, Bit::Zero, Bit::X, Bit::One]);
        let m = Value::mux(&v1(Bit::X), &d1, &d0);
        assert_eq!(bits(&m), vec![Bit::X, Bit::Zero, Bit::X, Bit::X]);
        assert_canonical(&m);
    }

    #[test]
    fn contention_merge_resolution() {
        // No drivers -> floating.
        assert_eq!(Value::contention_merge(4, &[]), Value::z(4));

        // Single driver passes through, whatever its state.
        for b in ALL {
            assert_eq!(Value::contention_merge(1, &[v1(b)]), v1(b));
        }

        // Agreement (including X with X) passes; disagreement -> X.
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::One), v1(Bit::One)]),
            v1(Bit::One)
        );
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::Zero), v1(Bit::Zero)]),
            v1(Bit::Zero)
        );
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::X), v1(Bit::X)]),
            v1(Bit::X)
        );
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::One), v1(Bit::Zero)]),
            v1(Bit::X)
        );
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::X), v1(Bit::One)]),
            v1(Bit::X)
        );
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::X), v1(Bit::Z)]),
            v1(Bit::X)
        );

        // Tri-state bus: a disabled (Z) driver yields to the enabled one.
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::Z), v1(Bit::One)]),
            v1(Bit::One)
        );
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::Z), v1(Bit::One), v1(Bit::One)]),
            v1(Bit::One)
        );
        assert_eq!(
            Value::contention_merge(1, &[v1(Bit::Z), v1(Bit::One), v1(Bit::Zero)]),
            v1(Bit::X)
        );

        // Per-bit resolution: bit 0 contends, bit 1 has one driver.
        let a = Value::from_bits(&[Bit::One, Bit::Z]);
        let b = Value::from_bits(&[Bit::Zero, Bit::One]);
        let m = Value::contention_merge(2, &[a, b]);
        assert_eq!(bits(&m), vec![Bit::X, Bit::One]);
        assert_canonical(&m);

        // Wide: two full 100-bit buses contending on every bit.
        let a = Value::all_ones(100);
        let b = Value::zero(100);
        let m = Value::contention_merge(100, &[a, b]);
        assert_eq!(m, Value::x(100));
        assert_canonical(&m);
    }

    #[test]
    fn width_ops() {
        // zero_extend grows with known zeros; same width is a clone.
        let v = Value::from_u64(4, 0xB);
        assert_eq!(v.zero_extend(4), v);
        let e = v.zero_extend(64);
        assert_eq!(e.width(), 64);
        assert_eq!(e.to_u64(), Some(0xB));
        let e = v.zero_extend(130);
        assert_eq!(e.width(), 130);
        for i in 0..130 {
            assert_eq!(e.bit(i), if i < 4 { v.bit(i) } else { Bit::Zero });
        }
        assert_canonical(&e);

        // sign_extend replicates the sign bit's state.
        let neg = Value::from_u64(4, 0xB); // 0b1011, sign = 1
        assert_eq!(neg.sign_extend(8).to_u64(), Some(0xFB));
        let pos = Value::from_u64(4, 0x3); // 0b0011, sign = 0
        assert_eq!(pos.sign_extend(8).to_u64(), Some(0x03));
        let sx = Value::from_bits(&[Bit::One, Bit::X]).sign_extend(4);
        assert_eq!(bits(&sx), vec![Bit::One, Bit::X, Bit::X, Bit::X]);
        let sz = Value::from_bits(&[Bit::One, Bit::Z]).sign_extend(4);
        assert_eq!(bits(&sz), vec![Bit::One, Bit::Z, Bit::Z, Bit::Z]);
        assert_canonical(&sx);

        // truncate keeps the low bits.
        let v = Value::from_u64(8, 0xAB);
        assert_eq!(v.truncate(4).to_u64(), Some(0xB));
        assert_eq!(v.truncate(8), v);

        // extract, including across limb boundaries.
        let mut pat = vec![Bit::Zero; 100];
        pat[50] = Bit::One;
        pat[63] = Bit::X;
        pat[64] = Bit::Z;
        pat[89] = Bit::One;
        let v = Value::from_bits(&pat);
        let e = v.extract(50, 40);
        assert_eq!(e.width(), 40);
        assert_eq!(e.bit(0), Bit::One);
        assert_eq!(e.bit(13), Bit::X);
        assert_eq!(e.bit(14), Bit::Z);
        assert_eq!(e.bit(39), Bit::One);
        assert_eq!(e.bit(20), Bit::Zero);
        assert_canonical(&e);
        assert_eq!(v.extract(0, 100), v);
        assert_eq!(v.extract(99, 1), Value::zero(1));

        // concat: states preserved, high/low placement, cross-limb.
        let hi = Value::from_u64(8, 0xAB);
        let lo = Value::from_u64(4, 0xC);
        assert_eq!(Value::concat(&hi, &lo).to_u64(), Some(0xABC));
        let hi = Value::from_bits(&[Bit::X]);
        let lo = Value::from_bits(&[Bit::Z]);
        assert_eq!(bits(&Value::concat(&hi, &lo)), vec![Bit::Z, Bit::X]);
        let hi = Value::all_ones(70);
        let lo = Value::zero(60);
        let c = Value::concat(&hi, &lo);
        assert_eq!(c.width(), 130);
        for i in 0..130 {
            assert_eq!(
                c.bit(i),
                if i < 60 { Bit::Zero } else { Bit::One },
                "bit {i}"
            );
        }
        assert_canonical(&c);
        // Round trip through extract.
        assert_eq!(c.extract(60, 70), Value::all_ones(70));
        assert_eq!(c.extract(0, 60), Value::zero(60));
    }

    #[test]
    fn from_u64_and_to_u64() {
        assert_eq!(Value::from_u64(1, 1).to_u64(), Some(1));
        assert_eq!(Value::from_u64(64, u64::MAX).to_u64(), Some(u64::MAX));
        assert_eq!(Value::zero(0).to_u64(), Some(0));
        assert_eq!(Value::x(8).to_u64(), None);
        assert_eq!(Value::z(8).to_u64(), None);
        assert_eq!(Value::zero(65).to_u64(), None); // too wide
    }

    #[test]
    #[should_panic(expected = "does not fit")]
    fn from_u64_rejects_overflow() {
        let _ = Value::from_u64(4, 0x1F);
    }

    #[test]
    fn hex_mask_canonical_rendering() {
        assert_eq!(mask_to_hex(&[]), "");
        assert_eq!(mask_to_hex(&[0]), "");
        assert_eq!(mask_to_hex(&[0x1fa3]), "1fa3");
        assert_eq!(mask_to_hex(&[0, 0x2]), "20000000000000000");
        assert_eq!(
            mask_to_hex(&[u64::MAX, u64::MAX]),
            "ffffffffffffffffffffffffffffffff"
        );
    }

    #[test]
    fn hex_mask_parsing() {
        // Basic + leading zeros tolerated.
        assert_eq!(parse_hex_mask("1fa3", 16).unwrap(), vec![0x1fa3]);
        assert_eq!(parse_hex_mask("00001fa3", 16).unwrap(), vec![0x1fa3]);
        assert_eq!(parse_hex_mask("", 16).unwrap(), vec![0]);
        assert_eq!(parse_hex_mask("", 0).unwrap(), Vec::<u64>::new());
        // Uppercase accepted.
        assert_eq!(parse_hex_mask("FF", 8).unwrap(), vec![0xFF]);
        // Longer than one limb.
        let s = format!("1{}", "0".repeat(16));
        assert_eq!(parse_hex_mask(&s, 65).unwrap(), vec![0, 1]);
        // Errors: bad digit, nonzero bits beyond width.
        assert_eq!(
            parse_hex_mask("1fg3", 16),
            Err(ValueError::InvalidHex {
                mask: "1fg3".into()
            })
        );
        assert_eq!(
            parse_hex_mask("1fa30", 16),
            Err(ValueError::MaskTooWide {
                mask: "1fa30".into(),
                width: 16
            })
        );
        assert_eq!(
            parse_hex_mask("ff", 4),
            Err(ValueError::MaskTooWide {
                mask: "ff".into(),
                width: 4
            })
        );
        // Leading zeros beyond capacity are fine.
        assert_eq!(
            parse_hex_mask("0000000000000000001fa3", 16).unwrap(),
            vec![0x1fa3]
        );
    }

    #[test]
    fn wire_value_roundtrip() {
        // Fully known.
        let v = Value::from_u64(16, 0x1FA3);
        let wv = v.to_wire_value();
        assert_eq!(
            wv,
            WireValue {
                v: "1fa3".into(),
                x: String::new(),
                z: String::new()
            }
        );
        assert_eq!(Value::from_wire_value(&wv, 16).unwrap(), v);

        // Mixed states, crossing a limb boundary.
        let mut pat = vec![Bit::Zero; 70];
        pat[0] = Bit::One;
        pat[1] = Bit::X;
        pat[2] = Bit::Z;
        pat[69] = Bit::One;
        let v = Value::from_bits(&pat);
        let wv = v.to_wire_value();
        assert_eq!(wv.v, "200000000000000001");
        assert_eq!(wv.x, "2");
        assert_eq!(wv.z, "4");
        assert_eq!(Value::from_wire_value(&wv, 70).unwrap(), v);

        // All-zero renders as empty masks and parses back.
        let v = Value::zero(32);
        let wv = v.to_wire_value();
        assert_eq!(wv, WireValue::default());
        assert_eq!(Value::from_wire_value(&wv, 32).unwrap(), v);

        // Overlapping masks rejected.
        let bad = WireValue {
            v: "1".into(),
            x: "1".into(),
            z: String::new(),
        };
        assert_eq!(
            Value::from_wire_value(&bad, 4),
            Err(ValueError::OverlappingMasks)
        );
        // Mask wider than the value rejected.
        let wide = WireValue {
            v: "10".into(),
            x: String::new(),
            z: String::new(),
        };
        assert_eq!(
            Value::from_wire_value(&wide, 4),
            Err(ValueError::MaskTooWide {
                mask: "10".into(),
                width: 4
            })
        );
    }

    #[test]
    fn display_rendering() {
        assert_eq!(Value::from_u64(16, 0x1FA3).to_string(), "0x1fa3");
        assert_eq!(Value::zero(8).to_string(), "0x0");
        assert_eq!(
            Value::from_bits(&[Bit::One, Bit::X, Bit::Zero, Bit::Z]).to_string(),
            "0bz0x1"
        );
    }

    #[test]
    fn predicates() {
        assert!(Value::x(3).has_x());
        assert!(!Value::x(3).has_z());
        assert!(Value::z(3).is_fully_z());
        assert!(!Value::from_bits(&[Bit::Z, Bit::One]).is_fully_z());
        assert!(Value::zero(0).is_fully_z()); // degenerate width
        assert!(Value::from_u64(32, 7).is_fully_known());
        assert!(!Value::from_bits(&[Bit::One, Bit::X]).is_fully_known());
    }
}
