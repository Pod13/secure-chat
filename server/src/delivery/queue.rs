//! The envelope queue: ciphertext waits here until the recipient Device acknowledges it, then
//! it is deleted. An unacknowledged envelope expires after 30 days. The server never sees what
//! is inside an envelope (Constitution I, V).

use crate::api::ws::{Cursor, Envelope, EnvelopeId, Outbox, OutboxError};
use crate::auth::DeviceId;
use crate::ports::Clock;
use sqlx::PgPool;
use std::{collections::HashMap, sync::Arc, sync::Mutex};
use tokio::sync::Notify;

/// How long an undelivered envelope is kept (Constitution V).
pub const ENVELOPE_TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// How many envelopes may wait for one Device, so a flood cannot fill the database.
pub const DEFAULT_MAX_QUEUED: i64 = 10_000;

#[derive(Debug, PartialEq, Eq)]
pub enum QueueError {
    /// The Device already has too many waiting envelopes.
    Full,
    Store,
}

pub struct PgQueue<C: Clock> {
    pool: PgPool,
    clock: Arc<C>,
    max_queued: i64,
    wakers: Mutex<HashMap<DeviceId, Arc<Notify>>>,
}

impl<C: Clock> PgQueue<C> {
    pub fn new(pool: PgPool, clock: Arc<C>) -> Self {
        Self::with_limit(pool, clock, DEFAULT_MAX_QUEUED)
    }

    pub fn with_limit(pool: PgPool, clock: Arc<C>, max_queued: i64) -> Self {
        Self {
            pool,
            clock,
            max_queued,
            wakers: Mutex::new(HashMap::new()),
        }
    }

    fn waker(&self, device: &DeviceId) -> Arc<Notify> {
        let mut wakers = self
            .wakers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        wakers.entry(*device).or_default().clone()
    }

    /// Adds an envelope for a Device and wakes its connection, if any.
    pub async fn enqueue(
        &self,
        device: &DeviceId,
        id: &EnvelopeId,
        ciphertext: &[u8],
    ) -> Result<(), QueueError> {
        let now = i64::try_from(self.clock.now_secs()).map_err(|_| QueueError::Store)?;
        let expires = now + i64::try_from(ENVELOPE_TTL_SECS).map_err(|_| QueueError::Store)?;
        let added = sqlx::query(
            "INSERT INTO envelopes (envelope_id, recipient_device_id, ciphertext, enqueued_at, expires_at) \
             SELECT $1, $2, $3, to_timestamp($4::bigint), to_timestamp($5::bigint) \
             WHERE (SELECT count(*) FROM envelopes WHERE recipient_device_id = $2) < $6",
        )
        .bind(id.as_slice())
        .bind(device.as_slice())
        .bind(ciphertext)
        .bind(now)
        .bind(expires)
        .bind(self.max_queued)
        .execute(&self.pool)
        .await
        .map_err(|_| QueueError::Store)?;
        if added.rows_affected() == 0 {
            return Err(QueueError::Full);
        }
        self.waker(device).notify_one();
        Ok(())
    }

    /// Deletes envelopes that expired at or before now. Returns how many were deleted.
    pub async fn purge_expired(&self) -> Result<u64, QueueError> {
        let now = i64::try_from(self.clock.now_secs()).map_err(|_| QueueError::Store)?;
        sqlx::query("DELETE FROM envelopes WHERE expires_at <= to_timestamp($1::bigint)")
            .bind(now)
            .execute(&self.pool)
            .await
            .map(|done| done.rows_affected())
            .map_err(|_| QueueError::Store)
    }
}

type Row = (Vec<u8>, Vec<u8>, i64, i64);

fn to_envelope((id, ciphertext, enqueued_at, seq): Row) -> Result<Envelope, OutboxError> {
    Ok(Envelope {
        id: id.try_into().map_err(|_| OutboxError)?,
        ciphertext,
        enqueued_at: u64::try_from(enqueued_at).map_err(|_| OutboxError)?,
        seq: u64::try_from(seq).map_err(|_| OutboxError)?,
    })
}

impl<C: Clock + Send + Sync> Outbox for PgQueue<C> {
    async fn pending(
        &self,
        device: &DeviceId,
        after: &Cursor,
        limit: usize,
    ) -> Result<Vec<Envelope>, OutboxError> {
        let now = i64::try_from(self.clock.now_secs()).map_err(|_| OutboxError)?;
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT envelope_id, ciphertext, extract(epoch FROM enqueued_at)::bigint, seq \
             FROM envelopes \
             WHERE recipient_device_id = $1 AND seq > $2 AND expires_at > to_timestamp($3::bigint) \
             ORDER BY seq LIMIT $4",
        )
        .bind(device.as_slice())
        .bind(i64::try_from(after.seq).map_err(|_| OutboxError)?)
        .bind(now)
        .bind(i64::try_from(limit).map_err(|_| OutboxError)?)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| OutboxError)?;
        rows.into_iter().map(to_envelope).collect()
    }

    async fn ack(&self, device: &DeviceId, ids: &[EnvelopeId]) -> Result<(), OutboxError> {
        let ids: Vec<&[u8]> = ids.iter().map(<[u8; 16]>::as_slice).collect();
        sqlx::query(
            "DELETE FROM envelopes WHERE recipient_device_id = $1 AND envelope_id = ANY($2)",
        )
        .bind(device.as_slice())
        .bind(ids)
        .execute(&self.pool)
        .await
        .map(|_| ())
        .map_err(|_| OutboxError)
    }

    async fn changed(&self, device: &DeviceId) {
        self.waker(device).notified().await;
    }
}
