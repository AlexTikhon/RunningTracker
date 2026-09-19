\set ON_ERROR_STOP on

SELECT 'CREATE DATABASE running_tracker_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'running_tracker_test')\gexec

\connect running_tracker_test

CREATE EXTENSION IF NOT EXISTS postgis;

