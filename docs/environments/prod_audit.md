# Production Environment Audit

**Date:** 2026-01-19
**Server:** Main Production Server (lattice-prod)
**Auditor:** Automated via Claude Code

---

## Executive Summary

The production environment is **functional but memory-constrained**. Current workload is sustainable, but scaling horizontally (adding more workers) would require additional RAM or offloading services to separate hosts.

| Resource | Status | Risk Level |
|----------|--------|------------|
| CPU | OK | Low |
| Memory | Constrained | **Medium** |
| Disk | OK | Low |
| Network | OK | Low |

---

## System Specifications

### Hardware

| Component | Specification |
|-----------|---------------|
| CPU | Intel Xeon E3-12xx v2 (Ivy Bridge) - 6 cores |
| RAM | 12 GB |
| Disk | 182 GB (virtio) |
| GPU | None |
| Swap | **None configured** |

### Software

| Component | Version |
|-----------|---------|
| OS | Ubuntu 24.04 LTS (Noble Numbat) |
| Kernel | 6.8.0-36-generic |
| Docker | 29.1.3 |
| Docker Compose | v5.0.0 |

---

## Resource Utilization

### Memory Analysis

```
Total:     12 GB
Used:      7.7 GB (64%)
Available: 4.0 GB (34%)
Swap:      0 B (NONE)
```

**Memory Breakdown by Service:**

| Service | Memory | % of Total | Notes |
|---------|--------|------------|-------|
| Airflow Webserver | 983 MB | 8.2% | 4 gunicorn workers |
| Airflow Scheduler | 694 MB | 5.8% | |
| Datadog Agent | 346 MB | 2.9% | **To be replaced by New Relic** |
| Milvus | 273 MB | 2.3% | Vector database |
| MinIO | 142 MB | 1.2% | Object storage |
| mail-extractor | 98 MB | 0.8% | |
| mail-deleter | 97 MB | 0.8% | |
| mail-upserter | 95 MB | 0.8% | |
| mail-parser | 86 MB | 0.7% | |
| mail-ocr-normalizer | 85 MB | 0.7% | |
| audit-writer | 84 MB | 0.7% | |
| attachment-chunker | 79 MB | 0.7% | |
| mail-embedder | 79 MB | 0.7% | |
| mail-chunker | 76 MB | 0.6% | |
| Postgres | 69 MB | 0.6% | |
| etcd | 57 MB | 0.5% | Milvus metadata |
| **Total Containers** | **~3.3 GB** | **28%** | |

**Non-Container Memory (~4.4 GB):**
- VS Code Server: ~1.5 GB (development sessions)
- Docker daemon: ~500 MB
- System/kernel: ~500 MB
- Claude CLI: ~750 MB (active session)
- Other processes: ~1.1 GB

### CPU Analysis

```
Cores:        6
Load Average: 2.39, 1.74, 1.51 (1m, 5m, 15m)
Utilization:  ~40% average
```

| Service | CPU % | Notes |
|---------|-------|-------|
| Datadog Agent | 8.1% | Highest CPU consumer |
| mail-ocr-normalizer | 7.5% | |
| mail-embedder | 7.4% | |
| audit-writer | 7.2% | |
| mail-upserter | 7.0% | |
| mail-deleter | 6.7% | |
| mail-parser | 6.6% | |
| attachment-chunker | 6.5% | |
| mail-chunker | 6.5% | |
| mail-extractor | 6.4% | |
| Milvus | 5.0% | |
| Airflow Scheduler | 3.2% | |
| Postgres | 2.7% | |
| etcd | 0.9% | |
| Airflow Webserver | 0.6% | |

**CPU Assessment:** Healthy. Load average of 2.39 on 6 cores = ~40% utilization.

### Disk Analysis

```
Total:     182 GB
Used:      53 GB (31%)
Available: 121 GB (69%)
```

**Docker Disk Usage:**

| Type | Size | Reclaimable |
|------|------|-------------|
| Images | 43.5 GB | 40.7 GB (93%) |
| Containers | 295 MB | 56 MB (18%) |
| Volumes | 1.0 GB | 43 KB (0%) |
| Build Cache | 35.5 GB | 32.4 GB (91%) |

**Disk Assessment:** Healthy, but 73 GB reclaimable via `docker system prune`.

---

## Running Services

### Container Inventory (16 Active)

**Lattice Workers (9):**
- lattice-mail-parser (port 3100)
- lattice-mail-chunker (port 3101)
- lattice-mail-embedder (port 3102)
- lattice-mail-upserter (port 3103)
- lattice-audit-writer (port 3104)
- lattice-mail-deleter (port 3105)
- lattice-mail-extractor (port 3106)
- lattice-attachment-chunker (port 3107)
- lattice-mail-ocr-normalizer (port 3109)

**Infrastructure (7):**
- lattice-postgres (port 5432)
- lattice-milvus (ports 9091, 19530)
- lattice-minio (ports 9000, 9001)
- lattice-etcd (internal)
- lattice-airflow-webserver (port 8088)
- lattice-airflow-scheduler (internal)
- lattice-datadog-agent (ports 8125/udp, 8126) - **To be replaced**

---

## Bottleneck Analysis

### Primary Bottleneck: Memory

**Current State:**
- 4 GB available is marginal for adding new services
- No swap configured = OOM killer risk
- Airflow consumes ~1.7 GB alone

**Impact:**
- Cannot safely add more worker replicas
- System vulnerable to memory spikes
- OOM conditions could kill critical services

### Secondary Concerns

1. **No Swap Space**
   - Risk: OOM killer will terminate processes without warning
   - Recommendation: Add 4-8 GB swap as safety net

2. **Docker Build Cache**
   - 35.5 GB of build cache (32.4 GB reclaimable)
   - Recommendation: Periodic cleanup with `docker builder prune`

3. **Datadog Agent**
   - Using 346 MB + 8% CPU
   - Action: Replace with New Relic Fluent Bit (~50 MB)
   - Savings: ~300 MB RAM, ~5% CPU

---

## Scalability Assessment

### Can We Scale?

| Dimension | Current | Headroom | Notes |
|-----------|---------|----------|-------|
| Workers | 9 | +1-2 max | Memory limited |
| CPU | 40% | 60% available | Good |
| Disk | 31% | 69% available | Good |
| Network | Low | High | Kafka is remote |

### Scaling Options

**Option 1: Vertical Scaling (Recommended First)**
- Add RAM to 16-24 GB
- Add swap space (4-8 GB)
- Estimated cost: Low (VM resize)

**Option 2: Horizontal Scaling**
- Offload OCR to GPU server (done)
- Offload Airflow to separate host
- Offload Milvus to managed service
- Estimated cost: Medium

**Option 3: Optimize Current Resources**
- Replace Datadog with New Relic Fluent Bit (~300 MB savings)
- Set memory limits on Airflow (cap at 1.5 GB)
- Clean Docker cache (free 73 GB disk)
- Add swap space (safety net)

---

## Recommendations

### Immediate Actions (P0)

1. **Add Swap Space**
   ```bash
   sudo fallocate -l 4G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

2. **Replace Datadog with New Relic**
   - Stop: `docker stop lattice-datadog-agent && docker rm lattice-datadog-agent`
   - Start: Use `newrelic-logging.yml` with workers
   - Saves: ~300 MB RAM, ~5% CPU

3. **Clean Docker Resources**
   ```bash
   docker builder prune -f          # Free 32 GB
   docker image prune -a -f         # Free 40 GB (unused images)
   ```

### Short-Term (P1)

4. **Set Container Memory Limits**
   - Add `mem_limit: 512m` to worker services
   - Add `mem_limit: 1536m` to Airflow services

5. **Monitor Memory Usage**
   - Set up New Relic alerts for memory > 85%
   - Create dashboard for resource tracking

### Long-Term (P2)

6. **Consider Managed Services**
   - Milvus → Zilliz Cloud
   - Postgres → Cloud SQL / RDS
   - Reduces operational burden

7. **Horizontal Scaling Plan**
   - Document runbook for multi-host deployment
   - Define service placement strategy

---

## Quick Reference

### Health Check Commands

```bash
# Memory
free -h

# Docker stats
docker stats --no-stream

# Disk
df -h / && docker system df

# Load
uptime

# Container health
docker ps --format "table {{.Names}}\t{{.Status}}"
```

### Emergency Actions

```bash
# If memory critical (>95%)
docker stop lattice-airflow-webserver  # Saves 1 GB

# If disk critical (>90%)
docker builder prune -f
docker image prune -a -f

# If container OOM
docker logs <container> --tail 100
docker restart <container>
```

---

## Appendix: Full Container List

```
NAME                          STATUS                 MEM USAGE    CPU %
lattice-mail-parser           Up 2 weeks (healthy)   85.5 MB      6.6%
lattice-mail-embedder         Up 2 weeks (healthy)   79.2 MB      7.4%
lattice-mail-ocr-normalizer   Up 2 weeks (healthy)   85.3 MB      7.5%
lattice-attachment-chunker    Up 2 weeks (healthy)   79.4 MB      6.5%
lattice-mail-chunker          Up 2 weeks (healthy)   76.2 MB      6.5%
lattice-mail-upserter         Up 2 weeks (healthy)   94.8 MB      7.0%
lattice-mail-extractor        Up 2 weeks (healthy)   98.1 MB      6.4%
lattice-audit-writer          Up 2 weeks (healthy)   84.1 MB      7.2%
lattice-mail-deleter          Up 2 weeks (healthy)   96.9 MB      6.7%
lattice-datadog-agent         Up 2 weeks (healthy)   345.9 MB     8.1%
lattice-airflow-scheduler     Up 2 weeks             693.9 MB     3.2%
lattice-airflow-webserver     Up 2 weeks (healthy)   983.2 MB     0.6%
lattice-milvus                Up 2 weeks (healthy)   272.8 MB     5.0%
lattice-postgres              Up 2 weeks (healthy)   68.6 MB      2.7%
lattice-etcd                  Up 2 weeks (healthy)   56.7 MB      0.9%
lattice-minio                 Up 2 weeks (healthy)   142.2 MB     0.0%
```

---

*Last updated: 2026-01-19 14:12 UTC*
