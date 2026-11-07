#![no_main]
use libfuzzer_sys::fuzz_target;
use server::api::ws::token_from_protocols;

fuzz_target!(|header: &str| {
    let _ = token_from_protocols(header);
});
