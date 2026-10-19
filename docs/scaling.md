# Scaling Path: 10x and 100x

This document outlines concrete engineering changes required to scale Newtonite from its current baseline to 10x (500k items, 5M activity rows) and 100x (5M items, 50M activity rows) operational throughput.

---

## 1. Scaling to 10x (500,000 Items / 5,000,000 Activity Rows)

At 10x load, the single-instance PostgreSQL schema remains viable, but specific table and worker optimizations become necessary:

### 1.1 Database Partitioning for `activity_log`
- **Challenge:** The append-only `activity_log` table reaches ~1.5 GB on disk. Composite indexes on `(item_id, created_at DESC)` grow larger than available RAM buffer caches.
- **Solution:** Convert `activity_log` to a declarative range-partitioned table by month:
  ```sql
  CREATE TABLE activity_log (
    id UUID NOT NULL,
    item_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    ...
  ) PARTITION BY RANGE (created_at);
  ```
- **Benefit:** Queries on recent item history touch only the current active month partition, keeping hot index pages in memory.

### 1.2 Read-Replica Pool Routing
- **Challenge:** Heavy search queries and attention dashboard aggregations consume read IOPS on the primary database writer.
- **Solution:** Provision one streaming read-replica. Configure pool routing in `server/src/db.ts`:
  - Mutating transactions (`BEGIN ... COMMIT`) and optimistic locking queries target the primary instance.
  - Read-only list queries (`GET /items`, `GET /attention`) route to the replica using `pgpool` with replica lag tolerance.

### 1.3 Dedicated Horizontally-Scaled Worker Instances
- **Challenge:** In-process worker execution competes for CPU cycles with Express HTTP request handling.
- **Solution:** Decouple workers into standalone container deployments (`RUN_WORKER_IN_API=false`). Run 3–5 worker replicas.
- **Concurrency Guarantee:** PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` guarantees zero contention between worker processes without requiring external coordinator locks.

### 1.4 Centralized Distributed Rate Limiting
- **Challenge:** In-memory rate limiting in Express becomes ineffective when multiple API instances run behind a load balancer.
- **Solution:** Back the login rate limiter with a Redis cluster using sliding-window token bucket scripts.

---

## 2. Scaling to 100x (5,000,000 Items / 50,000,000 Activity Rows)

At 100x load, architectural boundaries shift from a monolithic relational schema to a sharded event-driven model:

### 2.1 Team-Level Database Sharding
- **Challenge:** Single-node storage and connection limits are exhausted by hundreds of thousands of concurrent operations.
- **Architecture:** Shard PostgreSQL horizontally by `team_id` using Citus or application-directed connection routers.
- **Natural Boundary:** All operational queries, item lifecycles, and memberships are strictly scoped to a single team. Cross-team transactions are non-existent in core operations.

### 2.2 Change Data Capture (CDC) via Debezium & Kafka
- **Challenge:** Polling `outbox_events` via `SKIP LOCKED` introduces continuous database polling overhead at 10,000 writes/sec.
- **Architecture:** Replace outbox polling with Debezium reading directly from the PostgreSQL Write-Ahead Log (WAL).
- **Pipeline:**
  ```
  Postgres Transactions -> WAL -> Debezium Connector -> Apache Kafka -> Worker Consumer Groups
  ```
- **Guarantee:** Exactly-once and at-least-once asynchronous event delivery with zero polling load on database CPU.

### 2.3 Dedicated Search Cluster (OpenSearch / Elasticsearch)
- **Challenge:** Complex trigram queries (`pg_trgm`) and multi-term full-text searches on 5M rows degrade transactional index caches.
- **Architecture:** Stream work item mutations via Kafka into an OpenSearch cluster.
- **Benefit:** Sub-10ms full-text keyword search, autocomplete, and analytical faceting without touching operational PostgreSQL storage.
