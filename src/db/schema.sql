-- TiDB schema for Sonzai Memory Bench
-- Single table, multiple architectures write into it with different `approach` tags.
-- Requires: TiDB 8.4+ (vector + JSON). Full-text index optional on TiDB Cloud Serverless.

CREATE DATABASE IF NOT EXISTS memory_bench;
USE memory_bench;

-- Core memory table. All approaches share this schema.
-- `approach` distinguishes which run the memory belongs to so we can
-- benchmark in parallel without cross-contamination.
CREATE TABLE IF NOT EXISTS memories (
    id BIGINT PRIMARY KEY AUTO_RANDOM,
    approach VARCHAR(32) NOT NULL,           -- raw_vector | progressive_summary | hierarchical | typed_facts | spo_supersede
    agent_id VARCHAR(64) NOT NULL,           -- question_id from LongMemEval (one "agent" per question)
    level TINYINT NOT NULL DEFAULT 0,        -- 0=raw turn, 1=atomic fact, 2=summary
    content TEXT NOT NULL,
    content_tsv TEXT AS (LOWER(content)) STORED, -- for LIKE-based BM25 fallback

    -- Temporal: event_time = when it happened (extracted), ingested_at = when stored
    event_time DATETIME NOT NULL,
    ingested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Typed-facts signals
    importance FLOAT NOT NULL DEFAULT 0.5,   -- 0..1, LLM-scored
    entities JSON,                           -- ["alice", "car"]
    parent_id BIGINT,                        -- rolled-up-into pointer (consolidation)

    -- Five-lens columns. Nullable so legacy rows keep working.
    lens VARCHAR(16),                        -- archivist | empath | cartographer | timekeeper | librarian | composed
    subject VARCHAR(128),                    -- cartographer subject
    predicate VARCHAR(64),                   -- cartographer predicate
    object VARCHAR(256),                     -- cartographer object
    valence FLOAT,                           -- empath valence, -1..1
    kind VARCHAR(24),                        -- empath kind: preference | goal | commitment | aversion | mood | fact
    topic VARCHAR(64),                       -- librarian topic tag
    superseded_at DATETIME,                  -- soft delete; set when librarian/composer collapses this fact
    supersedes_id BIGINT,                    -- audit: which prior row this row replaces

    -- Embedding (nullable so non-vector approaches can skip)
    embedding VECTOR(1536),

    INDEX idx_approach_agent (approach, agent_id),
    INDEX idx_event_time (approach, agent_id, event_time),
    INDEX idx_level (approach, agent_id, level),
    INDEX idx_spo (approach, agent_id, subject, predicate),
    INDEX idx_topic (approach, agent_id, topic),
    INDEX idx_alive (approach, agent_id, superseded_at),
    VECTOR INDEX idx_vec ((VEC_COSINE_DISTANCE(embedding))) USING HNSW
);

-- Full-text index (TiDB 8.4+; ignored/errored in older). We create it best-effort
-- from the client code since syntax support varies by TiDB Cloud edition.

-- Run metadata for evaluation output.
CREATE TABLE IF NOT EXISTS runs (
    id BIGINT PRIMARY KEY AUTO_RANDOM,
    approach VARCHAR(32) NOT NULL,
    slice VARCHAR(64) NOT NULL,              -- question_type
    question_id VARCHAR(64) NOT NULL,
    question TEXT NOT NULL,
    gold_answer TEXT NOT NULL,
    predicted_answer TEXT,
    retrieved_ids JSON,
    judge_score TINYINT,                     -- 0 or 1
    judge_rationale TEXT,
    latency_ms INT,
    tokens_in INT,                            -- retrieval+answer prompt tokens
    tokens_out INT,                           -- retrieval+answer completion tokens
    embed_tokens INT,                         -- retrieval+answer embed tokens (query embeds)
    ingest_tokens_in INT,                     -- attributed ingest prompt tokens for this agent
    ingest_tokens_out INT,                    -- attributed ingest completion tokens
    ingest_embed_tokens INT,                  -- attributed ingest embed tokens
    ingest_latency_ms INT,                    -- total ingest wall-clock for this agent
    distractor_k INT NOT NULL DEFAULT 0,      -- number of injected distractor turns (0 = clean)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_run (approach, slice),
    INDEX idx_distractor (approach, distractor_k)
);
