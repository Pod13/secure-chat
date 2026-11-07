//! The only cryptographic entry point for the web client: an OpenMLS wrapper compiled to WASM.

use openmls::prelude::Ciphersuite;
use wasm_bindgen::prelude::wasm_bindgen;

/// The one MLS ciphersuite used by every Conversation (X25519, ChaCha20-Poly1305, Ed25519).
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// Reports the ciphersuite so the client can refuse an incompatible module.
#[wasm_bindgen]
pub fn ciphersuite_id() -> u16 {
    u16::from(CIPHERSUITE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_expected_ciphersuite() {
        assert_eq!(ciphersuite_id(), 0x0003);
    }
}
