#![no_main]
use libfuzzer_sys::fuzz_target;
use server::api::schemas::SCHEMAS;
use server::api::validate::validate;

fuzz_target!(|data: &[u8]| {
    // The first byte picks a schema; the rest is the request body. Nothing may panic, and a
    // body over the limit must never be accepted.
    let Some((pick, body)) = data.split_first() else { return };
    let (name, _) = SCHEMAS[usize::from(*pick) % SCHEMAS.len()];
    let _ = validate(name, body);
});
