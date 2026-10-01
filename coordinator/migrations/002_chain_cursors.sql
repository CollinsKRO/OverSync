CREATE TABLE IF NOT EXISTS chain_cursors (
    chain       TEXT    PRIMARY KEY CHECK (chain IN ('ethereum', 'soroban')),
    network_id  TEXT    NOT NULL,
    position    BIGINT  NOT NULL,
    cursor      TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE TABLE IF NOT EXISTS processed_chain_events (
    event_key   TEXT    PRIMARY KEY,
    chain       TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    position    BIGINT  NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);
