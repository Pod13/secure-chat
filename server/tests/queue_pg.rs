#![allow(clippy::unwrap_used)]

mod common;
mod fakes;

use common::db::{fresh_pool, insert_device};
use fakes::SharedClock;
use server::api::ws::{Cursor, Outbox};
use server::delivery::queue::{ENVELOPE_TTL_SECS, PgQueue, QueueError};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};

const A: [u8; 16] = [1; 16];
const B: [u8; 16] = [2; 16];

async fn setup(limit: i64) -> (PgQueue<SharedClock>, Arc<SharedClock>, PgPool) {
    let pool = fresh_pool().await;
    insert_device(&pool, 1).await;
    insert_device(&pool, 2).await;
    let clock = Arc::new(SharedClock::at(1_000_000));
    (
        PgQueue::with_limit(pool.clone(), clock.clone(), limit),
        clock,
        pool,
    )
}

async fn ids(queue: &PgQueue<SharedClock>, device: &[u8; 16], after: u64) -> Vec<u8> {
    let found = queue
        .pending(device, &Cursor { seq: after }, 100)
        .await
        .unwrap();
    found.iter().map(|e| e.id[0]).collect()
}

#[tokio::test]
async fn envelopes_come_back_in_arrival_order_even_within_one_second_with_random_ids() {
    let (queue, _clock, _pool) = setup(100).await;
    for id in [9u8, 3, 7, 1, 5] {
        queue.enqueue(&A, &[id; 16], &[id; 8]).await.unwrap();
    }
    assert_eq!(ids(&queue, &A, 0).await, vec![9, 3, 7, 1, 5]);
}

#[tokio::test]
async fn paging_continues_after_the_cursor_and_returns_the_stored_bytes() {
    let (queue, _clock, _pool) = setup(100).await;
    for id in 1..=4u8 {
        queue.enqueue(&A, &[id; 16], &[id; 8]).await.unwrap();
    }
    let first = queue.pending(&A, &Cursor::default(), 2).await.unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].ciphertext, vec![1; 8]);
    assert_eq!(first[0].enqueued_at, 1_000_000);
    let rest = queue
        .pending(&A, &Cursor { seq: first[1].seq }, 10)
        .await
        .unwrap();
    assert_eq!(rest.iter().map(|e| e.id[0]).collect::<Vec<_>>(), vec![3, 4]);
}

#[tokio::test]
async fn a_device_sees_only_its_own_envelopes() {
    let (queue, _clock, _pool) = setup(100).await;
    queue.enqueue(&A, &[1; 16], b"for a").await.unwrap();
    queue.enqueue(&B, &[2; 16], b"for b").await.unwrap();
    assert_eq!(ids(&queue, &A, 0).await, vec![1]);
    assert_eq!(ids(&queue, &B, 0).await, vec![2]);
}

#[tokio::test]
async fn an_ack_deletes_only_the_devices_own_envelopes() {
    let (queue, _clock, _pool) = setup(100).await;
    queue.enqueue(&A, &[1; 16], b"x").await.unwrap();
    queue.enqueue(&A, &[2; 16], b"x").await.unwrap();
    queue.enqueue(&B, &[3; 16], b"x").await.unwrap();
    queue.ack(&A, &[[1; 16], [3; 16]]).await.unwrap();
    assert_eq!(ids(&queue, &A, 0).await, vec![2]);
    assert_eq!(
        ids(&queue, &B, 0).await,
        vec![3],
        "B's envelope survives A's ack"
    );
    queue.ack(&A, &[]).await.unwrap();
}

#[tokio::test]
async fn an_envelope_expires_exactly_thirty_days_after_it_was_queued() {
    let (queue, clock, pool) = setup(100).await;
    queue.enqueue(&A, &[1; 16], b"x").await.unwrap();
    let seconds: i64 = sqlx::query_scalar(
        "SELECT extract(epoch FROM expires_at - enqueued_at)::bigint FROM envelopes",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        seconds, 2_592_000,
        "30 days, written out so the constant itself is checked"
    );
    assert_eq!(ENVELOPE_TTL_SECS, 2_592_000);
    clock.set(1_000_000 + ENVELOPE_TTL_SECS - 1);
    assert_eq!(ids(&queue, &A, 0).await, vec![1]);
    assert_eq!(queue.purge_expired().await, Ok(0));
    clock.set(1_000_000 + ENVELOPE_TTL_SECS);
    assert!(
        ids(&queue, &A, 0).await.is_empty(),
        "an expired envelope is no longer delivered"
    );
    assert_eq!(queue.purge_expired().await, Ok(1));
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM envelopes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn a_device_cannot_hold_more_than_its_limit_and_acks_free_space() {
    let (queue, _clock, _pool) = setup(3).await;
    for id in 1..=3u8 {
        queue.enqueue(&A, &[id; 16], b"x").await.unwrap();
    }
    assert_eq!(
        queue.enqueue(&A, &[4; 16], b"x").await,
        Err(QueueError::Full)
    );
    queue.enqueue(&B, &[5; 16], b"x").await.unwrap();
    queue.ack(&A, &[[1; 16]]).await.unwrap();
    queue.enqueue(&A, &[4; 16], b"x").await.unwrap();
}

#[tokio::test]
async fn the_database_rejects_oversized_or_duplicate_envelopes() {
    let (queue, _clock, _pool) = setup(100).await;
    assert_eq!(
        queue.enqueue(&A, &[1; 16], &vec![0u8; 131_073]).await,
        Err(QueueError::Store)
    );
    queue.enqueue(&A, &[1; 16], b"x").await.unwrap();
    assert_eq!(
        queue.enqueue(&A, &[1; 16], b"x").await,
        Err(QueueError::Store),
        "duplicate id"
    );
    assert_eq!(
        queue.enqueue(&[9; 16], &[2; 16], b"x").await,
        Err(QueueError::Store),
        "unknown device"
    );
}

#[tokio::test]
async fn enqueueing_wakes_a_waiting_connection_and_only_then() {
    let (queue, _clock, _pool) = setup(100).await;
    let queue = Arc::new(queue);
    let waiter = {
        let queue = queue.clone();
        tokio::spawn(async move { queue.changed(&A).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !waiter.is_finished(),
        "changed() must wait until something is enqueued"
    );
    queue.enqueue(&A, &[1; 16], b"x").await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), waiter)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_wakeup_is_not_lost_if_it_comes_first_and_is_used_up_once() {
    let (queue, _clock, _pool) = setup(100).await;
    queue.enqueue(&A, &[1; 16], b"x").await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), queue.changed(&A))
        .await
        .unwrap();
    let again = tokio::time::timeout(Duration::from_millis(150), queue.changed(&A)).await;
    assert!(
        again.is_err(),
        "the wakeup was already consumed, so changed() must wait again"
    );
}

#[tokio::test]
async fn one_devices_enqueue_does_not_wake_another_device() {
    let (queue, _clock, _pool) = setup(100).await;
    queue.enqueue(&B, &[1; 16], b"x").await.unwrap();
    let woke = tokio::time::timeout(Duration::from_millis(150), queue.changed(&A)).await;
    assert!(woke.is_err());
}

#[tokio::test]
async fn deleting_a_device_deletes_its_queue() {
    let (queue, _clock, pool) = setup(100).await;
    queue.enqueue(&A, &[1; 16], b"x").await.unwrap();
    sqlx::query("DELETE FROM devices")
        .execute(&pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM envelopes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
