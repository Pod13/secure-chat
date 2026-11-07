//! Fixed-size buckets for message plaintext, applied before MLS encryption (research R11).
//!
//! Layout: a 4-byte big-endian length, the data, then zero bytes up to the bucket size. Buckets
//! are 256 B, 1 KiB, 4 KiB, 16 KiB, then multiples of 64 KiB up to 1 MiB.

const HEADER: usize = 4;
const BUCKETS: [usize; 4] = [256, 1024, 4096, 16 * 1024];
const STEP: usize = 64 * 1024;
const MAX_PADDED: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum PadError {
    /// The data does not fit in the largest bucket.
    TooLarge,
    /// The input is not exactly what `pad` produces.
    Malformed,
}

/// The padded size for `len` bytes of data, or `None` if it is over the limit.
fn bucket_for(len: usize) -> Option<usize> {
    let needed = len.checked_add(HEADER)?;
    let size = match BUCKETS.iter().find(|bucket| **bucket >= needed) {
        Some(bucket) => *bucket,
        None => needed.div_ceil(STEP) * STEP,
    };
    (size <= MAX_PADDED).then_some(size)
}

pub fn pad(data: &[u8]) -> Result<Vec<u8>, PadError> {
    let size = bucket_for(data.len()).ok_or(PadError::TooLarge)?;
    let length = u32::try_from(data.len()).map_err(|_| PadError::TooLarge)?;
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(data);
    out.resize(size, 0);
    Ok(out)
}

/// Reverses `pad`. It accepts only the exact form `pad` produces, so two different inputs never
/// decode to the same data.
pub fn unpad(padded: &[u8]) -> Result<Vec<u8>, PadError> {
    let (header, rest) = padded.split_at_checked(HEADER).ok_or(PadError::Malformed)?;
    let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    let length = usize::try_from(length).map_err(|_| PadError::Malformed)?;
    let (data, padding) = rest.split_at_checked(length).ok_or(PadError::Malformed)?;
    let canonical = bucket_for(length) == Some(padded.len());
    if canonical && padding.iter().all(|b| *b == 0) {
        Ok(data.to_vec())
    } else {
        Err(PadError::Malformed)
    }
}
