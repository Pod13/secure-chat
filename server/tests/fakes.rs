//! In-memory fakes for the ports in `server/src/ports.rs`.

#![allow(dead_code)]

use server::ports::{Clock, Random};
use std::cell::Cell;

/// A clock the test moves by hand.
pub struct FakeClock(Cell<u64>);

impl FakeClock {
    pub fn at(secs: u64) -> Self {
        Self(Cell::new(secs))
    }

    pub fn advance(&self, secs: u64) {
        self.0.set(self.0.get() + secs);
    }
}

impl Clock for FakeClock {
    fn now_secs(&self) -> u64 {
        self.0.get()
    }
}

/// Predictable bytes (0, 1, 2, ...) for tests. NEVER use outside tests: it is not random.
#[derive(Default)]
pub struct CountingRandom(Cell<u8>);

impl Random for CountingRandom {
    fn fill(&self, buf: &mut [u8]) {
        for b in buf {
            *b = self.0.get();
            self.0.set(self.0.get().wrapping_add(1));
        }
    }
}
