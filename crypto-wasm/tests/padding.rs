//! Padding hides message length: every padded message has one of a few fixed sizes.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use crypto_wasm::padding::{PadError, pad, unpad};

const KIB: usize = 1024;
const MAX: usize = 1024 * KIB;

#[test]
fn small_messages_fill_the_smallest_bucket() {
    assert_eq!(pad(b"").unwrap().len(), 256);
    assert_eq!(pad(b"hi").unwrap().len(), 256);
}

#[test]
fn the_bucket_edges_are_exact() {
    // 4 bytes of the padded form hold the length, so 252 bytes is the most a 256 bucket carries.
    assert_eq!(pad(&[1; 252]).unwrap().len(), 256);
    assert_eq!(pad(&[1; 253]).unwrap().len(), KIB);
    assert_eq!(pad(&[1; KIB - 4]).unwrap().len(), KIB);
    assert_eq!(pad(&[1; KIB - 3]).unwrap().len(), 4 * KIB);
    assert_eq!(pad(&[1; 4 * KIB - 4]).unwrap().len(), 4 * KIB);
    assert_eq!(pad(&[1; 4 * KIB - 3]).unwrap().len(), 16 * KIB);
    assert_eq!(pad(&[1; 16 * KIB - 4]).unwrap().len(), 16 * KIB);
    assert_eq!(pad(&[1; 16 * KIB - 3]).unwrap().len(), 64 * KIB);
}

#[test]
fn large_messages_use_64_kib_steps() {
    assert_eq!(pad(&[1; 64 * KIB - 4]).unwrap().len(), 64 * KIB);
    assert_eq!(pad(&[1; 64 * KIB - 3]).unwrap().len(), 128 * KIB);
    assert_eq!(pad(&[1; 200 * KIB]).unwrap().len(), 256 * KIB);
}

#[test]
fn the_size_limit_is_one_mebibyte_of_padded_data() {
    assert_eq!(pad(&vec![1; MAX - 4]).unwrap().len(), MAX);
    assert_eq!(pad(&vec![1; MAX - 3]), Err(PadError::TooLarge));
}

#[test]
fn padding_is_removed_exactly() {
    for len in [0, 1, 251, 252, 253, 1019, 1020, 1021, 20_000, 70_000] {
        let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        assert_eq!(unpad(&pad(&data).unwrap()).unwrap(), data, "length {len}");
    }
}

#[test]
fn padding_bytes_are_zero() {
    let padded = pad(b"abc").unwrap();
    assert_eq!(&padded[..4], &[0, 0, 0, 3]);
    assert_eq!(&padded[4..7], b"abc");
    assert!(padded[7..].iter().all(|b| *b == 0));
}

#[test]
fn input_that_is_not_a_bucket_size_is_rejected() {
    assert_eq!(unpad(&[]), Err(PadError::Malformed));
    assert_eq!(unpad(&[0; 3]), Err(PadError::Malformed));
    assert_eq!(unpad(&[0; 255]), Err(PadError::Malformed));
    assert_eq!(unpad(&[0; 257]), Err(PadError::Malformed));
    assert_eq!(unpad(&vec![0; 64 * KIB + 1]), Err(PadError::Malformed));
    assert_eq!(unpad(&vec![0; MAX + 64 * KIB]), Err(PadError::Malformed));
}

#[test]
fn a_length_longer_than_the_data_is_rejected() {
    let mut padded = pad(b"abc").unwrap();
    padded[3] = 253; // 253 bytes cannot fit after the 4-byte header in a 256 bucket
    assert_eq!(unpad(&padded), Err(PadError::Malformed));
    padded[0] = 0xff;
    assert_eq!(unpad(&padded), Err(PadError::Malformed));
}

#[test]
fn padding_that_is_larger_than_needed_is_rejected() {
    // "abc" belongs in a 256 bucket; the same bytes inside a 1 KiB bucket are not canonical.
    let mut oversized = vec![0; KIB];
    oversized[3] = 3;
    oversized[4..7].copy_from_slice(b"abc");
    assert_eq!(unpad(&oversized), Err(PadError::Malformed));
}

#[test]
fn non_zero_padding_is_rejected() {
    let mut padded = pad(b"abc").unwrap();
    let last = padded.len() - 1;
    padded[last] = 1;
    assert_eq!(unpad(&padded), Err(PadError::Malformed));
    let mut padded = pad(b"abc").unwrap();
    padded[7] = 1;
    assert_eq!(unpad(&padded), Err(PadError::Malformed));
}
