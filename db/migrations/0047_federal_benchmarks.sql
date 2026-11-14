-- Phase 11 part 3: federal benchmarks (no dollar values).
--
-- Public reference data from the Federal Judicial Center's Integrated Database (civil), as documented in
-- docs/source/fjc-civil-codebook.md. It holds no firm or client information. Only the fields Huis uses are kept:
-- district, nature of suit, filing and termination dates, disposition and judgment. The dollar fields (AMTREC,
-- DEMANDED) are deliberately not imported: the FJC advises against analysing AMTREC (decided by Tracy, 13 November
-- 2026: benchmarks, no dollars).
--
-- Loaded only by Huis staff with the database owner's connection (scripts/operator/import-fjc-idb.ts); the app can
-- read it but never write it.

CREATE TABLE huis.federal_cases (
  id          bigserial PRIMARY KEY,
  district    char(2) NOT NULL CHECK (district ~ '^[0-9A-Z][0-9A-Z-]$' AND district <> '-8'),
  nos         smallint NOT NULL CHECK (nos BETWEEN 100 AND 999),
  filed       date NOT NULL,
  terminated  date NOT NULL CHECK (terminated >= filed),
  disp        smallint NOT NULL CHECK (disp BETWEEN 0 AND 20),
  judgment    smallint CHECK (judgment BETWEEN 1 AND 4)
);
CREATE INDEX federal_cases_nos ON huis.federal_cases (nos, district, terminated);

CREATE TABLE huis.federal_imports (
  id                bigserial PRIMARY KEY,
  file_name         text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 300),
  sha256            char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  rows_read         integer NOT NULL CHECK (rows_read >= 0),
  rows_kept         integer NOT NULL CHECK (rows_kept >= 0),
  terminated_from   date,
  terminated_through date,
  imported_at       timestamptz NOT NULL DEFAULT now()
);

-- Readable by the app (public data; no firm column), written only by the owner (not forced, so the owner's import
-- isn't blocked; no other role has write grants).
ALTER TABLE huis.federal_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.federal_imports ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON huis.federal_cases, huis.federal_imports TO huis_app;
CREATE POLICY federal_cases_read ON huis.federal_cases FOR SELECT TO huis_app USING (true);
CREATE POLICY federal_imports_read ON huis.federal_imports FOR SELECT TO huis_app USING (true);
