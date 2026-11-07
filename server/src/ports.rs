//! Injected I/O (Constitution XIII). Security-critical code never reads the clock or the random
//! number generator directly; it is given these ports, so tests can control time and randomness.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// A source of the current time.
pub trait Clock {
    /// Seconds since the Unix epoch.
    fn now_secs(&self) -> u64;
}

/// A source of cryptographically secure random bytes.
pub trait Random {
    /// Fills `buf` with random bytes.
    fn fill(&self, buf: &mut [u8]);
}

/// Real clock. A clock set before 1970 reports 0 instead of failing.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    }
}

/// Real randomness from the operating system.
pub struct OsRandom;

impl Random for OsRandom {
    #[allow(clippy::expect_used)] // Weak randomness is worse than stopping: do not continue.
    fn fill(&self, buf: &mut [u8]) {
        getrandom::fill(buf).expect("operating system randomness is unavailable");
    }
}

/// A clock that can be shared between tasks and swapped in tests.
pub type DynClock = Arc<dyn Clock + Send + Sync>;
/// Randomness that can be shared between tasks and swapped in tests.
pub type DynRandom = Arc<dyn Random + Send + Sync>;

impl Clock for DynClock {
    fn now_secs(&self) -> u64 {
        (**self).now_secs()
    }
}

impl Random for DynRandom {
    fn fill(&self, buf: &mut [u8]) {
        (**self).fill(buf);
    }
}
