#![allow(clippy::unwrap_used)]

mod common;

use common::db::fresh_pool;
use server::abuse::limits::{Bucket, Kind, LimitStore};
use server::abuse::pg::PgLimitStore;
use server::logging::TruncatedIp;

fn bucket(name: &str) -> Bucket {
    Bucket::for_ip(Kind::Login, &TruncatedIp::new(name.parse().unwrap()))
}

#[tokio::test]
async fn hits_in_one_window_count_up_from_one() {
    let store = PgLimitStore::new(fresh_pool().await);
    let b = bucket("192.0.2.5");
    for expected in 1..=3 {
        assert_eq!(store.hit(&b, 1_000).await, Ok(expected));
    }
    assert_eq!(
        store.hit(&b, 1_060).await,
        Ok(1),
        "a new window starts again at one"
    );
    assert_eq!(
        store.hit(&bucket("198.51.100.1"), 1_000).await,
        Ok(1),
        "another bucket is separate"
    );
}

#[tokio::test]
async fn simultaneous_hits_are_each_counted_exactly_once() {
    let store = std::sync::Arc::new(PgLimitStore::new(fresh_pool().await));
    let b = bucket("192.0.2.5");
    let tasks: Vec<_> = (0..20)
        .map(|_| {
            let (store, b) = (store.clone(), b.clone());
            tokio::spawn(async move { store.hit(&b, 5_000).await.unwrap() })
        })
        .collect();
    let mut seen = Vec::new();
    for t in tasks {
        seen.push(t.await.unwrap());
    }
    seen.sort_unstable();
    assert_eq!(seen, (1..=20).collect::<Vec<u32>>());
}

#[tokio::test]
async fn purging_deletes_only_windows_that_started_before_the_cutoff() {
    let store = PgLimitStore::new(fresh_pool().await);
    let b = bucket("192.0.2.5");
    store.hit(&b, 1_000).await.unwrap();
    store.hit(&b, 2_000).await.unwrap();
    store.hit(&b, 3_000).await.unwrap();
    assert_eq!(store.purge_before(2_500).await, Ok(2));
    assert_eq!(
        store.hit(&b, 3_000).await,
        Ok(2),
        "the recent window survived"
    );
}
