FROM postgres:16-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release \
 && echo "deb https://packagecloud.io/timescale/timescaledb/debian/ bookworm main" \
      > /etc/apt/sources.list.d/timescale_timescaledb.list \
 && curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey \
      | gpg --dearmor -o /etc/apt/trusted.gpg.d/timescale_timescaledb.gpg \
 && echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgres.gpg \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      timescaledb-2-postgresql-16 \
      postgresql-16-pgvector \
      postgresql-16-postgis-3 \
      postgresql-16-postgis-3-scripts \
      timescaledb-tools \
 && rm -rf /var/lib/apt/lists/* \
 && echo "shared_preload_libraries = 'timescaledb'" \
      >> /usr/share/postgresql/postgresql.conf.sample

COPY initdb.d /docker-entrypoint-initdb.d
