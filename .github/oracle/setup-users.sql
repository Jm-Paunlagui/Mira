-- =============================================================================
-- CI: the two schemas Mira's checks need, in the Oracle Free PDB (FREEPDB1).
-- Run as SYSDBA after the container is healthy (see .github/workflows/ci.yml).
--   MIRA     — the test suite's schema (MIRA_DB_USER)
--   MIRA_SIM — the simulation's own schema (MIRA_SIM_DB_USERNAME)
-- Both get exactly what README "Database prerequisites" lists.
-- =============================================================================
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET VERIFY OFF
ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE USER MIRA IDENTIFIED BY "&1" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS;
-- CREATE TRIGGER: an integration test proves insertMany reads back a key a trigger rewrites.
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE,
      CREATE SYNONYM, CREATE MATERIALIZED VIEW, CREATE TRIGGER TO MIRA;

CREATE USER MIRA_SIM IDENTIFIED BY "&1" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS;
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE,
      CREATE SYNONYM, CREATE MATERIALIZED VIEW TO MIRA_SIM;

EXIT
