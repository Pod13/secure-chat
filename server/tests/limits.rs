#![allow(clippy::unwrap_used)]

mod fakes;

use fakes::{FakeClock, MemoryLimitStore};
use server::abuse::limits::{Bucket, Kind, LimitStore, Refused, check};
use server::logging::TruncatedIp;

fn ip(text: &str) -> TruncatedIp {
    TruncatedIp::new(text.parse().unwrap())
}

#[tokio::test]
async fn requests_up_to_the_limit_pass_and_the_next_is_refused_with_a_retry_time() {
    let (store, clock) = (MemoryLimitStore::default(), FakeClock::at(7_200 + 100));
    let bucket = Bucket::for_ip(Kind::Signup, &ip("192.0.2.5"));
    for _ in 0..5 {
        assert_eq!(check(&store, &clock, Kind::Signup, &bucket).await, Ok(()));
    }
    let refused = check(&store, &clock, Kind::Signup, &bucket).await;
    assert_eq!(refused, Err(Refused::TooMany { retry_after: 3_500 }));
}

#[tokio::test]
async fn a_new_window_starts_fresh() {
    let (store, clock) = (MemoryLimitStore::default(), FakeClock::at(120));
    let bucket = Bucket::for_ip(Kind::Login, &ip("192.0.2.5"));
    for _ in 0..21 {
        let _ = check(&store, &clock, Kind::Login, &bucket).await;
    }
    assert!(check(&store, &clock, Kind::Login, &bucket).await.is_err());
    clock.advance(60);
    assert_eq!(check(&store, &clock, Kind::Login, &bucket).await, Ok(()));
}

#[tokio::test]
async fn retry_after_is_one_second_at_the_end_of_a_window() {
    let (store, clock) = (MemoryLimitStore::default(), FakeClock::at(119));
    let bucket = Bucket::for_ip(Kind::Login, &ip("192.0.2.5"));
    for _ in 0..20 {
        check(&store, &clock, Kind::Login, &bucket).await.unwrap();
    }
    let refused = check(&store, &clock, Kind::Login, &bucket).await;
    assert_eq!(refused, Err(Refused::TooMany { retry_after: 1 }));
}

#[tokio::test]
async fn buckets_and_kinds_are_counted_separately() {
    let (store, clock) = (MemoryLimitStore::default(), FakeClock::at(1_000));
    let (a, b) = (
        Bucket::for_ip(Kind::Login, &ip("192.0.2.5")),
        Bucket::for_ip(Kind::Login, &ip("198.51.100.5")),
    );
    for _ in 0..20 {
        check(&store, &clock, Kind::Login, &a).await.unwrap();
    }
    assert!(check(&store, &clock, Kind::Login, &a).await.is_err());
    assert!(
        check(&store, &clock, Kind::Login, &b).await.is_ok(),
        "another address is unaffected"
    );
    let signup = Bucket::for_ip(Kind::Signup, &ip("192.0.2.5"));
    assert!(
        check(&store, &clock, Kind::Signup, &signup).await.is_ok(),
        "another kind is unaffected"
    );
}

#[tokio::test]
async fn a_broken_store_refuses_requests_instead_of_allowing_them() {
    let (store, clock) = (MemoryLimitStore::default(), FakeClock::at(1_000));
    *store.broken.lock().unwrap() = true;
    let bucket = Bucket::for_ip(Kind::Login, &ip("192.0.2.5"));
    assert_eq!(
        check(&store, &clock, Kind::Login, &bucket).await,
        Err(Refused::Unavailable)
    );
}

#[test]
fn bucket_names_use_only_truncated_addresses_or_hash_prefixes_and_fit_the_column() {
    let from_ip = Bucket::for_ip(Kind::DeliverToken, &ip("203.0.113.99"));
    assert_eq!(from_ip.as_str(), "dtoken:ip:203.0.113.0");
    let v6 = Bucket::for_ip(Kind::Recovery, &ip("2001:db8:abcd:1234::1"));
    assert_eq!(v6.as_str(), "recover:ip:2001:db8:abcd::");
    let hash = [0xAB; 32];
    let from_hash = Bucket::for_hash(Kind::DeliverRecipient, &hash);
    assert_eq!(from_hash.as_str(), format!("drecip:h:{}", "ab".repeat(16)));
    for b in [&from_ip, &v6, &from_hash] {
        assert!(b.as_str().len() <= 64, "{}", b.as_str());
    }
    assert!(!from_ip.as_str().contains("99"), "the host part is gone");
}

#[test]
fn every_kind_has_a_sensible_rule() {
    use Kind::*;
    for kind in [
        Signup,
        Login,
        InviteCreate,
        DeliverToken,
        DeliverRecipient,
        BlobUpload,
        Recovery,
    ] {
        let rule = kind.rule();
        assert!(
            rule.max_hits > 0 && (60..=3600).contains(&rule.window_secs),
            "{kind:?}"
        );
    }
    assert_eq!(
        Recovery.rule().max_hits,
        5,
        "recovery guesses are tightly limited"
    );
}

#[tokio::test]
async fn purging_removes_only_old_windows() {
    let (store, clock) = (MemoryLimitStore::default(), FakeClock::at(10_000));
    let bucket = Bucket::for_ip(Kind::Login, &ip("192.0.2.5"));
    check(&store, &clock, Kind::Login, &bucket).await.unwrap();
    clock.advance(600_000);
    check(&store, &clock, Kind::Login, &bucket).await.unwrap();
    assert_eq!(store.purge_before(300_000).await, Ok(1));
    assert_eq!(store.counters.lock().unwrap().len(), 1);
}
