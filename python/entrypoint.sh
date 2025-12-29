#!/bin/bash
set -euo pipefail

# Wait for postgres to be ready
echo "Waiting for PostgreSQL to be ready..."
while ! nc -z postgres 5432; do
  sleep 1
done
echo "PostgreSQL is ready!"

# Initialize the database if it hasn't been done yet
# if ! airflow users list 2>/dev/null | grep -q airflow; then
  echo "Initializing Airflow database..."
  airflow db migrate

  # 5) Idempotent helper functions
  var_exists() { airflow variables get "$1" >/dev/null 2>&1; }
  conn_exists() { airflow connections get "$1" >/dev/null 2>&1; }

  echo "Setting up Airflow variables..."


    # thinking we remove the init from the dockercompose.
  user_exists() { airflow users list | awk '{print $1}' | grep -qx "$1"; }

  if ! user_exists airflow; then
    echo "Creating admin user..."
    airflow users create \
      --role Admin \
      --username airflow \
      --password airflow \
      --email airflow@airflow.com \
      --firstname airflow \
      --lastname airflow
  fi

  # 8) Connections (idempotent)

exec "$@"
