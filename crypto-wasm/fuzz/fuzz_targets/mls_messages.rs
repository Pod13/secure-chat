#![no_main]
use crypto_wasm::Client;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Untrusted bytes in every place the wrapper accepts them: none may panic.
    let Ok(mut client) = Client::new(b"fuzz") else { return };
    let Ok(group) = client.create_group() else { return };
    let _ = client.add_member(&group, data);
    let _ = client.receive(&group, data);
    let _ = client.join(data);
});
