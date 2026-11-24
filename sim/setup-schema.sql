-- =============================================================================
-- Mira simulation schema — run ONCE as SYSDBA (or a DBA user).
--
-- The simulation owns this schema outright: every run drops the SIM_* objects
-- it finds there and rebuilds them, so it must never point at a schema that
-- holds anything else (the test suite's MIRA schema included).
--
--   sqlplus / as sysdba @sim/setup-schema.sql <password>
--
-- In the local Docker container (oracle19c, PDB ORCLPDB1):
--   docker cp sim/setup-schema.sql oracle19c:/tmp/s.sql
--   docker exec oracle19c sqlplus -s / as sysdba @/tmp/s.sql '<password>'
--
-- The PDB name below is the Docker container's; change it for another server.
--
-- Then set MIRA_SIM_DB_USERNAME / MIRA_SIM_DB_PASSWORD in .env.
-- =============================================================================
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET VERIFY OFF
DEFINE sim_user = MIRA_SIM
DEFINE sim_password = "&1"

ALTER SESSION SET CONTAINER = ORCLPDB1;

CREATE USER &sim_user IDENTIFIED BY "&sim_password"
  DEFAULT TABLESPACE USERS
  QUOTA UNLIMITED ON USERS;

-- Exactly what the simulation exercises: tables, views, sequences, synonyms
-- (insertFromQuery's synonym target) and materialized views (performance utils).
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE,
      CREATE SYNONYM, CREATE MATERIALIZED VIEW TO &sim_user;

EXIT
