mod fakes;

use fakes::{CountingRandom, FakeClock};
use server::ports::{Clock, OsRandom, Random, SystemClock};

#[test]
fn fake_clock_only_moves_when_told() {
    let clock = FakeClock::at(1_000);
    assert_eq!(clock.now_secs(), 1_000);
    clock.advance(30);
    assert_eq!(clock.now_secs(), 1_030);
}

#[test]
fn counting_random_is_predictable() {
    let mut buf = [0u8; 4];
    CountingRandom::default().fill(&mut buf);
    assert_eq!(buf, [0, 1, 2, 3]);
}

#[test]
fn system_clock_is_after_2026() {
    assert!(SystemClock.now_secs() > 1_767_225_600);
}

#[test]
fn os_random_differs_between_calls() {
    let (mut a, mut b) = ([0u8; 32], [0u8; 32]);
    OsRandom.fill(&mut a);
    OsRandom.fill(&mut b);
    assert_ne!(a, b);
    assert_ne!(a, [0u8; 32]);
}
