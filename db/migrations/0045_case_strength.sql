-- Phase 11 part 1: Case Outcome Intelligence (case strength, the holes in the case, next steps).
--
-- The analysis itself is computed each time it's read, as the reader, from confirmed Case DNA (src/intelligence/
-- strength.ts): nothing about it is stored. What is stored is the attorneys' answer to a gap ("Attorney override"
-- in the spec): set aside as not relevant or already handled, or context added, with a note. Same access as Case
-- DNA: firm staff who can see the Matter read them; staff who can change it (not read-only staff) write them.

CREATE TABLE huis.case_gap_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES huis.firms(id),
  matter_id   uuid NOT NULL,
  gap_key     text NOT NULL CHECK (gap_key ~ '^[a-z-]+(:[0-9a-f-]{36})?$'),
  decision    text NOT NULL CHECK (decision IN ('set_aside', 'context')),
  note        text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  decided_by  uuid NOT NULL,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, gap_key),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id)
);
ALTER TABLE huis.case_gap_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.case_gap_reviews FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.case_gap_reviews TO huis_app;
CREATE POLICY case_gap_reviews_select ON huis.case_gap_reviews FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id));
CREATE POLICY case_gap_reviews_insert ON huis.case_gap_reviews FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND decided_by = huis.current_user_id());
CREATE POLICY case_gap_reviews_update ON huis.case_gap_reviews FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND decided_by = huis.current_user_id());
CREATE POLICY case_gap_reviews_delete ON huis.case_gap_reviews FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id));

-- The firm and Matter of a review never change.
CREATE FUNCTION huis.case_gap_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.firm_id IS DISTINCT FROM OLD.firm_id OR NEW.matter_id IS DISTINCT FROM OLD.matter_id OR NEW.gap_key IS DISTINCT FROM OLD.gap_key THEN
    RAISE EXCEPTION 'a gap review''s firm, Matter and gap never change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_gap_reviews_guard BEFORE UPDATE ON huis.case_gap_reviews FOR EACH ROW EXECUTE FUNCTION huis.case_gap_reviews_guard();

-- Deleting an unpaid trial's data (0041) removes every table with the firm's id as huis_security, so that role
-- needs DELETE here too. Granted table by table (not as a default for every future table, which would also reach
-- add-only platform tables: security review 34); test/trial-deletion.test.ts fails if a firm table is missed.
GRANT SELECT, DELETE ON huis.case_gap_reviews TO huis_security;
