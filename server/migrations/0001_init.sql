-- Server schema. Every table and column corresponds to a row of
-- specs/001-secure-realtime-chat/data-inventory.md; anything not listed there must not be stored.
-- Fixed sizes are enforced here as well as in the API (defence in depth).

CREATE TABLE accounts (
    account_id          bytea PRIMARY KEY CHECK (octet_length(account_id) = 16),
    identity_public_key bytea NOT NULL CHECK (octet_length(identity_public_key) = 32),
    created_on          date  NOT NULL,
    last_connected_on   date  NOT NULL
);

CREATE TABLE devices (
    device_id         bytea PRIMARY KEY CHECK (octet_length(device_id) = 16),
    account_id        bytea NOT NULL REFERENCES accounts ON DELETE CASCADE,
    device_public_key bytea NOT NULL UNIQUE CHECK (octet_length(device_public_key) = 32),
    linked_on         date  NOT NULL,
    label_blob        bytea NOT NULL CHECK (octet_length(label_blob) <= 1024),
    push_endpoint     text  CHECK (length(push_endpoint) <= 2048),
    push_p256dh       bytea CHECK (octet_length(push_p256dh) = 65),
    push_auth         bytea CHECK (octet_length(push_auth) = 16),
    CHECK ((push_endpoint IS NULL) = (push_p256dh IS NULL) AND (push_endpoint IS NULL) = (push_auth IS NULL))
);
CREATE INDEX devices_account_idx ON devices (account_id);

CREATE TABLE key_packages (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id   bytea   NOT NULL REFERENCES devices ON DELETE CASCADE,
    key_package bytea   NOT NULL CHECK (octet_length(key_package) <= 4096),
    last_resort boolean NOT NULL DEFAULT false,
    created_on  date    NOT NULL
);
CREATE UNIQUE INDEX key_packages_one_last_resort ON key_packages (device_id) WHERE last_resort;
CREATE INDEX key_packages_device_idx ON key_packages (device_id);

CREATE TABLE delivery_tokens (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    device_id  bytea   NOT NULL REFERENCES devices ON DELETE CASCADE,
    revoked    boolean NOT NULL DEFAULT false
);
CREATE INDEX delivery_tokens_device_idx ON delivery_tokens (device_id);

CREATE TABLE envelopes (
    -- Arrival order. Never sent to clients; it keeps delivery in order within one second.
    seq                 bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    envelope_id         bytea PRIMARY KEY CHECK (octet_length(envelope_id) = 16),
    recipient_device_id bytea       NOT NULL REFERENCES devices ON DELETE CASCADE,
    ciphertext          bytea       NOT NULL CHECK (octet_length(ciphertext) <= 131072),
    enqueued_at         timestamptz NOT NULL,
    expires_at          timestamptz NOT NULL,
    CHECK (expires_at <= enqueued_at + interval '30 days')
);
CREATE INDEX envelopes_recipient_idx ON envelopes (recipient_device_id, seq);
CREATE INDEX envelopes_expiry_idx ON envelopes (expires_at);

-- The owner is the creator (needed to revoke). Who redeems an Invite is never recorded.
-- Operator seed Invites have no owner; only service Invites may be ownerless.
CREATE TABLE invites (
    token_hash       bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    kind             text        NOT NULL CHECK (kind IN ('service', 'contact', 'group')),
    owner_account_id bytea       REFERENCES accounts ON DELETE CASCADE,
    CHECK (owner_account_id IS NOT NULL OR kind = 'service'),
    expires_at       timestamptz NOT NULL,
    max_uses         integer     NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
    uses             integer     NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
    revoked          boolean     NOT NULL DEFAULT false
);
CREATE INDEX invites_expiry_idx ON invites (expires_at);

CREATE TABLE blobs (
    blob_id          bytea PRIMARY KEY CHECK (octet_length(blob_id) = 16),
    size_bytes       bigint      NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
    expires_at       timestamptz NOT NULL,
    fetches_remaining integer    NOT NULL CHECK (fetches_remaining >= 0)
);
CREATE INDEX blobs_expiry_idx ON blobs (expires_at);

CREATE TABLE backups (
    account_id        bytea PRIMARY KEY REFERENCES accounts ON DELETE CASCADE,
    blob_id           bytea  NOT NULL CHECK (octet_length(blob_id) = 16),
    access_token_hash bytea  NOT NULL CHECK (octet_length(access_token_hash) = 32),
    size_bytes        bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608)
);

CREATE TABLE link_requests (
    request_id           bytea PRIMARY KEY CHECK (octet_length(request_id) = 16),
    device_public_key    bytea       NOT NULL CHECK (octet_length(device_public_key) = 32),
    ephemeral_public_key bytea       NOT NULL CHECK (octet_length(ephemeral_public_key) = 32),
    expires_at           timestamptz NOT NULL
);
CREATE INDEX link_requests_expiry_idx ON link_requests (expires_at);

CREATE TABLE auth_nonces (
    device_id  bytea PRIMARY KEY REFERENCES devices ON DELETE CASCADE,
    nonce      bytea       NOT NULL CHECK (octet_length(nonce) = 32),
    expires_at timestamptz NOT NULL
);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    device_id  bytea       NOT NULL REFERENCES devices ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_device_idx ON sessions (device_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- Rate limiting: a truncated-IP or token bucket, never an identifier of a person.
CREATE TABLE abuse_counters (
    bucket       text        NOT NULL CHECK (length(bucket) <= 64),
    window_start timestamptz NOT NULL,
    hits         integer     NOT NULL CHECK (hits >= 0),
    PRIMARY KEY (bucket, window_start)
);
CREATE INDEX abuse_counters_window_idx ON abuse_counters (window_start);

-- Operator actions only (no user content). Each entry commits to the one before it.
CREATE TABLE audit_log (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at         timestamptz NOT NULL,
    action     text  NOT NULL CHECK (length(action) <= 64),
    prev_hash  bytea NOT NULL CHECK (octet_length(prev_hash) = 32),
    entry_hash bytea NOT NULL UNIQUE CHECK (octet_length(entry_hash) = 32)
);
CREATE INDEX audit_log_time_idx ON audit_log (at);
