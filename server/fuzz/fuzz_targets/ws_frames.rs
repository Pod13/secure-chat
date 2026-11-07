#![no_main]
use libfuzzer_sys::fuzz_target;
use server::api::ws::parse_incoming;

fuzz_target!(|text: &str| {
    let _ = parse_incoming(text);
});
