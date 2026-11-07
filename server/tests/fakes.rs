//! In-memory fakes for the ports in `server/src/ports.rs`.

#![allow(dead_code, clippy::unwrap_used)]

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

use server::auth::{AuthStore, DeviceId, Hash, StoreError};
use std::{collections::HashMap, sync::Mutex};

/// In-memory auth storage. `fail_after(n)` makes every call from the n-th onward fail, to test
/// that storage errors are reported and never mistaken for success.
#[derive(Default)]
pub struct MemoryAuthStore {
    pub keys: Mutex<HashMap<DeviceId, Hash>>,
    pub nonces: Mutex<HashMap<DeviceId, (Hash, u64)>>,
    pub sessions: Mutex<HashMap<Hash, (DeviceId, u64)>>,
    calls: Mutex<usize>,
    fail_from: Mutex<Option<usize>>,
}

impl MemoryAuthStore {
    pub fn with_device(device: DeviceId, key: Hash) -> Self {
        let store = Self::default();
        store.keys.lock().unwrap().insert(device, key);
        store
    }

    pub fn fail_after(&self, calls: usize) {
        *self.fail_from.lock().unwrap() = Some(calls);
    }

    fn tick(&self) -> Result<(), StoreError> {
        let mut calls = self.calls.lock().unwrap();
        *calls += 1;
        match *self.fail_from.lock().unwrap() {
            Some(limit) if *calls > limit => Err(StoreError),
            _ => Ok(()),
        }
    }
}

impl AuthStore for MemoryAuthStore {
    async fn device_key(&self, device: &DeviceId) -> Result<Option<Hash>, StoreError> {
        self.tick()?;
        Ok(self.keys.lock().unwrap().get(device).copied())
    }

    async fn put_nonce(
        &self,
        device: &DeviceId,
        nonce: Hash,
        expires_at: u64,
    ) -> Result<(), StoreError> {
        self.tick()?;
        self.nonces
            .lock()
            .unwrap()
            .insert(*device, (nonce, expires_at));
        Ok(())
    }

    async fn take_nonce(&self, device: &DeviceId) -> Result<Option<(Hash, u64)>, StoreError> {
        self.tick()?;
        Ok(self.nonces.lock().unwrap().remove(device))
    }

    async fn put_session(
        &self,
        token_hash: Hash,
        device: DeviceId,
        expires_at: u64,
    ) -> Result<(), StoreError> {
        self.tick()?;
        self.sessions
            .lock()
            .unwrap()
            .insert(token_hash, (device, expires_at));
        Ok(())
    }

    async fn session(&self, token_hash: &Hash) -> Result<Option<(DeviceId, u64)>, StoreError> {
        self.tick()?;
        Ok(self.sessions.lock().unwrap().get(token_hash).copied())
    }

    async fn delete_device_sessions(&self, device: &DeviceId) -> Result<(), StoreError> {
        self.tick()?;
        self.nonces.lock().unwrap().remove(device);
        self.sessions
            .lock()
            .unwrap()
            .retain(|_, (d, _)| d != device);
        Ok(())
    }
}

use server::abuse::limits::{Bucket, LimitStore, StoreError as LimitStoreError};

/// In-memory rate-limit counters.
#[derive(Default)]
pub struct MemoryLimitStore {
    pub counters: Mutex<HashMap<(String, u64), u32>>,
    pub broken: Mutex<bool>,
}

impl LimitStore for MemoryLimitStore {
    async fn hit(&self, bucket: &Bucket, window_start: u64) -> Result<u32, LimitStoreError> {
        if *self.broken.lock().unwrap() {
            return Err(LimitStoreError);
        }
        let mut counters = self.counters.lock().unwrap();
        let count = counters
            .entry((bucket.as_str().to_string(), window_start))
            .or_insert(0);
        *count += 1;
        Ok(*count)
    }

    async fn purge_before(&self, before: u64) -> Result<u64, LimitStoreError> {
        let mut counters = self.counters.lock().unwrap();
        let had = counters.len();
        counters.retain(|(_, start), _| *start >= before);
        Ok((had - counters.len()) as u64)
    }
}

use server::api::ws::{Cursor, Envelope, EnvelopeId, Outbox, OutboxError};

/// In-memory delivery queue. `add` + `notify` mimic a message arriving while connected.
#[derive(Default)]
pub struct MemoryOutbox {
    pub items: Mutex<Vec<(DeviceId, Envelope)>>,
    pub notify: tokio::sync::Notify,
    pub broken: Mutex<bool>,
}

impl MemoryOutbox {
    pub fn add(&self, device: DeviceId, id: u8, enqueued_at: u64) {
        let seq = self.items.lock().unwrap().len() as u64 + 1;
        let envelope = Envelope {
            id: [id; 16],
            ciphertext: vec![id; 4],
            enqueued_at,
            seq,
        };
        self.items.lock().unwrap().push((device, envelope));
    }

    pub fn ids_for(&self, device: DeviceId) -> Vec<u8> {
        let items = self.items.lock().unwrap();
        items
            .iter()
            .filter(|(d, _)| *d == device)
            .map(|(_, e)| e.id[0])
            .collect()
    }
}

impl Outbox for MemoryOutbox {
    async fn pending(
        &self,
        device: &DeviceId,
        after: &Cursor,
        limit: usize,
    ) -> Result<Vec<Envelope>, OutboxError> {
        if *self.broken.lock().unwrap() {
            return Err(OutboxError);
        }
        let mut found: Vec<Envelope> = self
            .items
            .lock()
            .unwrap()
            .iter()
            .filter(|(d, e)| d == device && e.seq > after.seq)
            .map(|(_, e)| Envelope {
                id: e.id,
                ciphertext: e.ciphertext.clone(),
                enqueued_at: e.enqueued_at,
                seq: e.seq,
            })
            .collect();
        found.sort_by_key(|e| e.seq);
        found.truncate(limit);
        Ok(found)
    }

    async fn ack(&self, device: &DeviceId, ids: &[EnvelopeId]) -> Result<(), OutboxError> {
        self.items
            .lock()
            .unwrap()
            .retain(|(d, e)| !(d == device && ids.contains(&e.id)));
        Ok(())
    }

    async fn changed(&self, _device: &DeviceId) {
        self.notify.notified().await;
    }
}

/// A clock that can be shared between tasks and moved by hand.
pub struct SharedClock(pub std::sync::atomic::AtomicU64);

impl SharedClock {
    pub fn at(secs: u64) -> Self {
        Self(std::sync::atomic::AtomicU64::new(secs))
    }

    pub fn set(&self, secs: u64) {
        self.0.store(secs, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Clock for SharedClock {
    fn now_secs(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}
