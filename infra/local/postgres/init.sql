-- Lattice Database Initialization
-- This script is run by Docker on first startup

-- Create databases
CREATE DATABASE lattice;
CREATE DATABASE airflow;

-- Connect to lattice and run migrations
\c lattice

-- Run the initial schema migration
\i /docker-entrypoint-initdb.d/migrations/001_initial_schema.sql

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE lattice TO lattice;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO lattice;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO lattice;

-- Connect to airflow database
\c airflow

-- Grant permissions for Airflow
GRANT ALL PRIVILEGES ON DATABASE airflow TO lattice;
