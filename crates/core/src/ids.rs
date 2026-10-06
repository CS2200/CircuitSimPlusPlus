//! Strongly-typed identifiers (BACKEND.md task B1).
//!
//! Every identifier the engine hands out is a newtype over `u32` so nets,
//! components, wires, and circuits can never be confused at compile time.
//! All of them serialize transparently as plain `u32`s, so the JSON wire
//! format pinned in `docs/ipc.md` §4 is unaffected by the newtypes.

use std::fmt;

use serde::{Deserialize, Serialize};

macro_rules! id_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub u32);

        impl $name {
            /// Index into `Vec`-based storage keyed by this id.
            pub fn idx(self) -> usize {
                self.0 as usize
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }
    };
}

id_newtype! {
    /// Opaque component identifier (stable within a loaded document).
    CompId
}
id_newtype! {
    /// Index of a wire within its circuit's `wires` array.
    WireIdx
}
id_newtype! {
    /// Opaque net identifier, assigned by the engine at load time.
    ///
    /// Internal only — nets are derived, never stored in files
    /// (DESIGN.md §5.1). The frontend learns the net ↔ wire mapping from
    /// `LoadResult::net_map` and uses `NetId`s in `NetDiffs`.
    NetId
}
id_newtype! {
    /// Index of a circuit within a document's `circuits` array.
    CircuitIdx
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pinned wire format (`docs/ipc.md`) spells ids as bare JSON
    /// numbers; the newtypes must serialize transparently.
    #[test]
    fn ids_serialize_as_bare_numbers() {
        assert_eq!(serde_json::to_string(&CompId(17)).unwrap(), "17");
        assert_eq!(serde_json::to_string(&NetId(0)).unwrap(), "0");
        let back: WireIdx = serde_json::from_str("42").unwrap();
        assert_eq!(back, WireIdx(42));
    }

    #[test]
    fn idx_accessor() {
        assert_eq!(CircuitIdx(3).idx(), 3);
    }
}
