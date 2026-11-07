#![no_main]
use crypto_wasm::padding::{pad, unpad};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Anything may be fed to `unpad`; if it accepts, padding the result must give the same bytes.
    if let Ok(plain) = unpad(data) {
        assert_eq!(pad(&plain).as_deref(), Ok(data));
    }
    // Anything that fits must survive a round trip.
    if let Ok(padded) = pad(data) {
        assert_eq!(unpad(&padded).as_deref(), Ok(data));
    }
});
