//! `rle-hex-v1` codec — run-length-encoded hex memory images
//! (DESIGN.md §5.2/App. A; kept byte-compatible with legacy `.sim`
//! `contents` strings and assembler-emitted `.hex` autoload files).
//!
//! Grammar (whitespace between tokens is flexible — spaces, newlines):
//!
//! ```text
//! image := "" | token ( ws+ token )*
//! token := value | count "-" value
//! count := [1-9][0-9]*          (decimal; zero is not a valid count)
//! value := [0-9a-fA-F]{1,16}    (hex; at most one machine word)
//! ```
//!
//! A bare `value` is one word; `count-value` is `count` consecutive copies.
//! Canonical encoding collapses runs of length ≥ 2 into `count-value` form
//! and zero-pads values to the memory's hex width.

/// RLE-hex parse error.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RleError {
    /// Token has an invalid run count (empty, leading zero, non-decimal, or
    /// overflowing `u64`). Carries the offending token.
    #[error("invalid count in token '{0}'")]
    BadCount(String),
    /// Token has an invalid hex value (empty, >16 digits, or non-hex).
    /// Carries the offending token.
    #[error("invalid hex value in token '{0}' (expected 1-16 hex digits)")]
    BadValue(String),
    /// The image would expand past the caller's word cap.
    #[error("image has {have} words, exceeding the limit of {max}")]
    TooManyWords {
        /// Words the image expands to (at least) once the cap is crossed.
        have: u64,
        /// The `max_words` limit passed to [`parse`].
        max: u64,
    },
}

/// Decode an RLE-hex image into words. `max_words` bounds the expansion
/// (DESIGN.md §11 — a hostile `999999999-ffff` token must not OOM the
/// process).
pub fn parse(image: &str, max_words: usize) -> Result<Vec<u64>, RleError> {
    let mut out: Vec<u64> = Vec::new();
    for token in image.split_whitespace() {
        let (count, value_str) = match token.split_once('-') {
            Some((count_str, value_str)) => {
                if count_str.is_empty()
                    || !count_str.bytes().all(|b| b.is_ascii_digit())
                    || count_str.starts_with('0')
                {
                    return Err(RleError::BadCount(token.to_string()));
                }
                let count: u64 = count_str
                    .parse()
                    .map_err(|_| RleError::BadCount(token.to_string()))?;
                (count, value_str)
            }
            None => (1, token),
        };
        if value_str.is_empty()
            || value_str.len() > 16
            || !value_str.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(RleError::BadValue(token.to_string()));
        }
        let value = u64::from_str_radix(value_str, 16)
            .map_err(|_| RleError::BadValue(token.to_string()))?;
        let have = out.len() as u64;
        if count > max_words as u64 || have + count > max_words as u64 {
            return Err(RleError::TooManyWords {
                have: have + count,
                max: max_words as u64,
            });
        }
        out.extend(std::iter::repeat_n(value, count as usize));
    }
    Ok(out)
}

/// Encode words in canonical `rle-hex-v1`: runs of length ≥ 2 collapse to
/// `count-value`; values zero-padded to `hex_digits`.
pub fn encode(words: &[u64], hex_digits: usize) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < words.len() {
        let run_end = (i + 1..words.len())
            .find(|&j| words[j] != words[i])
            .unwrap_or(words.len());
        let run = run_end - i;
        if !out.is_empty() {
            out.push(' ');
        }
        if run >= 2 {
            out.push_str(&format!(
                "{}-{:0width$x}",
                run,
                words[i],
                width = hex_digits
            ));
        } else {
            out.push_str(&format!("{:0width$x}", words[i], width = hex_digits));
        }
        i = run_end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: usize = 1 << 20;

    #[test]
    fn parse_basics() {
        assert_eq!(parse("", MAX).unwrap(), Vec::<u64>::new());
        assert_eq!(parse("0000", MAX).unwrap(), vec![0]);
        assert_eq!(parse("4-0001", MAX).unwrap(), vec![1, 1, 1, 1]);
        assert_eq!(
            parse("0000 4-0001 ff", MAX).unwrap(),
            vec![0, 1, 1, 1, 1, 0xff]
        );
        // Whitespace leniency (files end with newlines).
        assert_eq!(
            parse("  0000\n4-0001\tff \n", MAX).unwrap(),
            vec![0, 1, 1, 1, 1, 0xff]
        );
        // Uppercase hex fine.
        assert_eq!(parse("FF", MAX).unwrap(), vec![0xff]);
        // Full word width.
        assert_eq!(parse("ffffffffffffffff", MAX).unwrap(), vec![u64::MAX]);
    }

    #[test]
    fn parse_errors() {
        assert_eq!(
            parse("3-0f-2", MAX),
            Err(RleError::BadValue("3-0f-2".into()))
        );
        assert_eq!(parse("0-0f", MAX), Err(RleError::BadCount("0-0f".into())));
        assert_eq!(parse("-0f", MAX), Err(RleError::BadCount("-0f".into())));
        assert_eq!(parse("2-xyz", MAX), Err(RleError::BadValue("2-xyz".into())));
        assert_eq!(
            parse("fffffffffffffffff", MAX),
            Err(RleError::BadValue("fffffffffffffffff".into()))
        );
        // Expansion cap.
        assert_eq!(
            parse("1000000-ff", 10),
            Err(RleError::TooManyWords {
                have: 1_000_000,
                max: 10
            })
        );
        assert_eq!(
            parse("ff ff ff", 2),
            Err(RleError::TooManyWords { have: 3, max: 2 })
        );
    }

    #[test]
    fn encode_canonical() {
        assert_eq!(encode(&[], 4), "");
        assert_eq!(encode(&[0x1fa3], 4), "1fa3");
        assert_eq!(encode(&[1, 1, 1, 1], 4), "4-0001");
        assert_eq!(encode(&[0, 1, 1, 1, 1, 0xff], 4), "0000 4-0001 00ff");
        // Runs of exactly 1 stay bare; runs of 2 collapse.
        assert_eq!(encode(&[5, 6, 6], 2), "05 2-06");
    }

    #[test]
    fn roundtrip() {
        let words = vec![0, 1, 1, 1, 0xabcd, 0xabcd, 7, 0, 0, 0, 0, 0];
        let encoded = encode(&words, 4);
        assert_eq!(parse(&encoded, MAX).unwrap(), words);
    }
}
