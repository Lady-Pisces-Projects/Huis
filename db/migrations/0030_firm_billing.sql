-- Phase 10 part 3: firm billing — timekeeping, rates, expenses and invoices to clients (decision #30 a).
--
-- * Time is kept per Matter in minutes and billed in tenths of an hour (6-minute increments, rounded up).
--   Each entry keeps the rate in force when it was entered (from the firm's rate table, never typed by the
--   timekeeper); billing staff can adjust it while it's unbilled.
-- * Firm staff who can see a Matter see its time and expenses (ethical walls apply); they record their own
--   time; billing staff (owner, managing partner, administrator, billing administrator) record anyone's.
-- * An invoice starts as a draft holding the Matter's unbilled items. Issuing it gives it the firm's next
--   number and copies every line into the invoice, so what the client was sent never changes afterwards;
--   its time and expenses are then locked. Voiding an issued invoice keeps it (marked void) and returns its
--   items to unbilled.
-- * Clients see their Matter's issued invoices (never drafts, never the time sheets themselves).
-- * Payments are recorded, not taken: money moves outside Huis until a legal payment processor (O-10).
--   Trust/IOLTA accounting is not part of this.
-- * Billing continues while the firm's subscription pauses new work: getting paid isn't new work.

CREATE FUNCTION huis.is_billing_manager() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(huis.app_role()::text IN ('firm_owner', 'managing_partner', 'firm_admin', 'billing_admin'), false)
$$;
GRANT EXECUTE ON FUNCTION huis.is_billing_manager() TO huis_app;

-- Who may prepare, issue and void the Matter's invoices and record payments: billing staff, and its lead
-- attorney (who can see it).
CREATE FUNCTION huis.can_invoice_matter(p_matter_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT huis.can_see_matter(p_matter_id) AND huis.is_internal_role(huis.app_role())
     AND (huis.is_billing_manager()
          OR EXISTS (SELECT 1 FROM huis.matters m WHERE m.id = p_matter_id AND m.lead_attorney_id = huis.current_user_id()))
$$;
ALTER FUNCTION huis.can_invoice_matter(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.can_invoice_matter(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.can_invoice_matter(uuid) TO huis_app;

-- ---------------------------------------------------------------------------
-- Rates: a person's standard hourly rate, optionally a different one on a Matter, from a date.
-- ---------------------------------------------------------------------------
CREATE TABLE huis.billing_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES huis.firms(id),
  user_id         uuid NOT NULL,
  matter_id       uuid,
  rate_cents      int NOT NULL CHECK (rate_cents BETWEEN 0 AND 10000000),
  effective_from  date NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id)
);
CREATE UNIQUE INDEX billing_rates_one_per_day ON huis.billing_rates (user_id, coalesce(matter_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);

-- The rate for this person on this Matter on this day: the Matter's own rate first, then their standard one.
CREATE FUNCTION huis.rate_for(p_firm_id uuid, p_user_id uuid, p_matter_id uuid, p_on date) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT r.rate_cents FROM huis.billing_rates r
   WHERE r.firm_id = p_firm_id AND r.user_id = p_user_id AND (r.matter_id = p_matter_id OR r.matter_id IS NULL)
     AND r.effective_from <= p_on
     -- Only your own rate, unless you're billing staff (rates are theirs to see).
     AND p_firm_id = huis.current_firm_id() AND (p_user_id = huis.current_user_id() OR huis.is_billing_manager())
   ORDER BY (r.matter_id IS NULL), r.effective_from DESC LIMIT 1
$$;
ALTER FUNCTION huis.rate_for(uuid, uuid, uuid, date) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.rate_for(uuid, uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.rate_for(uuid, uuid, uuid, date) TO huis_app;

CREATE FUNCTION huis.billing_rate_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  NEW.created_by := huis.current_user_id();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER billing_rates_stamp BEFORE INSERT ON huis.billing_rates FOR EACH ROW EXECUTE FUNCTION huis.billing_rate_stamp();

ALTER TABLE huis.billing_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.billing_rates FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON huis.billing_rates TO huis_app;
GRANT SELECT ON huis.billing_rates TO huis_security;
-- Billing staff see and set rates; everyone sees their own.
CREATE POLICY billing_rates_select ON huis.billing_rates FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role())
         AND (huis.is_billing_manager() OR user_id = huis.current_user_id()));
CREATE POLICY billing_rates_insert ON huis.billing_rates FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_billing_manager()
              AND (matter_id IS NULL OR huis.can_see_matter(matter_id)));
CREATE POLICY billing_rates_delete ON huis.billing_rates FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_billing_manager());

-- ---------------------------------------------------------------------------
-- Invoices (declared before time and expenses, which point at them).
-- ---------------------------------------------------------------------------
CREATE TABLE huis.invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES huis.firms(id),
  matter_id       uuid NOT NULL,
  client_id       uuid NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  number          text,
  notes           text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  issued_on       date,
  due_on          date,
  time_cents      bigint,
  expense_cents   bigint,
  total_cents     bigint,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  issued_by       uuid,
  voided_by       uuid,
  voided_at       timestamptz,
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, number),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, client_id) REFERENCES huis.clients(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK (status = 'draft' OR (issued_on IS NOT NULL AND due_on IS NOT NULL AND total_cents IS NOT NULL))
);
CREATE INDEX invoices_matter ON huis.invoices (firm_id, matter_id);

-- Invoice numbers: INV-<year>-<0001>, one sequence per firm per year, given when issued.
CREATE TABLE huis.invoice_counters (
  firm_id uuid NOT NULL REFERENCES huis.firms(id),
  year    int NOT NULL,
  last    int NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, year)
);
GRANT SELECT, INSERT, UPDATE ON huis.invoice_counters TO huis_security;

-- What the client was sent, line by line, copied when the invoice is issued.
CREATE TABLE huis.invoice_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  position      int NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('time', 'expense')),
  line_date     date NOT NULL,
  who           text NOT NULL DEFAULT '',
  description   text NOT NULL,
  tenths        int,
  rate_cents    int,
  amount_cents  bigint NOT NULL,
  FOREIGN KEY (firm_id, invoice_id) REFERENCES huis.invoices(firm_id, id),
  UNIQUE (invoice_id, position)
);

CREATE TABLE huis.invoice_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  received_on   date NOT NULL,
  method        text NOT NULL CHECK (method IN ('check', 'card', 'ach', 'wire', 'cash', 'other')),
  reference     text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),
  recorded_by   uuid NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, invoice_id) REFERENCES huis.invoices(firm_id, id),
  FOREIGN KEY (firm_id, recorded_by) REFERENCES huis.users(firm_id, id)
);

-- ---------------------------------------------------------------------------
-- Time and expenses
-- ---------------------------------------------------------------------------
CREATE TABLE huis.time_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  matter_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  work_date    date NOT NULL,
  minutes      int NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  description  text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  billable     boolean NOT NULL DEFAULT true,
  rate_cents   int CHECK (rate_cents IS NULL OR rate_cents BETWEEN 0 AND 10000000),
  invoice_id   uuid,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, invoice_id) REFERENCES huis.invoices(firm_id, id)
);
CREATE INDEX time_entries_matter ON huis.time_entries (firm_id, matter_id, work_date);
CREATE INDEX time_entries_invoice ON huis.time_entries (invoice_id);

CREATE TABLE huis.expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  matter_id    uuid NOT NULL,
  incurred_on  date NOT NULL,
  description  text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000000000),
  billable     boolean NOT NULL DEFAULT true,
  invoice_id   uuid,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, invoice_id) REFERENCES huis.invoices(firm_id, id)
);
CREATE INDEX expenses_matter ON huis.expenses (firm_id, matter_id, incurred_on);
CREATE INDEX expenses_invoice ON huis.expenses (invoice_id);

-- Tenths of an hour billed for these minutes (6-minute increments, rounded up), and what they come to.
CREATE FUNCTION huis.billed_tenths(p_minutes int) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT ceil(p_minutes / 6.0)::int $$;
CREATE FUNCTION huis.time_amount(p_minutes int, p_rate_cents int) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT round(huis.billed_tenths(p_minutes) * coalesce(p_rate_cents, 0) / 10.0)::bigint
$$;
GRANT EXECUTE ON FUNCTION huis.billed_tenths(int), huis.time_amount(int, int) TO huis_app, huis_security;

-- The invoice an item is on, if it's anything but a draft (then the item can't change).
CREATE FUNCTION huis.invoice_locked(p_invoice_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT p_invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.invoices i WHERE i.id = p_invoice_id AND i.status <> 'draft')
$$;
ALTER FUNCTION huis.invoice_locked(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.invoice_locked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.invoice_locked(uuid) TO huis_app;
GRANT SELECT ON huis.invoices TO huis_security;

-- Time: who and when from the database; the rate from the rate table unless billing staff set it;
-- nothing on an issued invoice changes; an item joins or leaves only a draft invoice of its own Matter.
CREATE FUNCTION huis.time_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF huis.invoice_locked(OLD.invoice_id) THEN RAISE EXCEPTION 'This time is on an issued invoice and can''t be changed.'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := huis.current_user_id();
    NEW.created_at := clock_timestamp();
    IF NEW.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'New time starts unbilled.'; END IF;
    IF NEW.rate_cents IS NULL OR NOT huis.is_billing_manager() THEN
      NEW.rate_cents := huis.rate_for(NEW.firm_id, NEW.user_id, NEW.matter_id, NEW.work_date);
    END IF;
    RETURN NEW;
  END IF;
  -- Issuing, voiding and deleting a draft (huis_security) only attach and release items.
  IF current_user = 'huis_security' THEN RETURN NEW; END IF;
  IF huis.invoice_locked(OLD.invoice_id) OR huis.invoice_locked(NEW.invoice_id) THEN
    RAISE EXCEPTION 'This time is on an issued invoice and can''t be changed.';
  END IF;
  IF NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Time stays on its Matter.';
  END IF;
  IF NEW.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     AND NOT EXISTS (SELECT 1 FROM huis.invoices i WHERE i.id = NEW.invoice_id AND i.matter_id = NEW.matter_id AND i.status = 'draft') THEN
    RAISE EXCEPTION 'Time goes only on a draft invoice of its own Matter.';
  END IF;
  -- Only billing staff change the rate, or move time between people; a change of person or day re-reads the rate.
  IF NOT huis.is_billing_manager() THEN
    IF NEW.user_id <> OLD.user_id THEN RAISE EXCEPTION 'Only billing staff can move time to someone else.'; END IF;
    IF NEW.rate_cents IS DISTINCT FROM OLD.rate_cents OR NEW.work_date <> OLD.work_date THEN
      NEW.rate_cents := huis.rate_for(NEW.firm_id, NEW.user_id, NEW.matter_id, NEW.work_date);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON huis.time_entries FOR EACH ROW EXECUTE FUNCTION huis.time_entry_guard();

CREATE FUNCTION huis.expense_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF huis.invoice_locked(OLD.invoice_id) THEN RAISE EXCEPTION 'This expense is on an issued invoice and can''t be changed.'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := huis.current_user_id();
    NEW.created_at := clock_timestamp();
    IF NEW.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'New expenses start unbilled.'; END IF;
    RETURN NEW;
  END IF;
  IF current_user = 'huis_security' THEN RETURN NEW; END IF;
  IF huis.invoice_locked(OLD.invoice_id) OR huis.invoice_locked(NEW.invoice_id) THEN
    RAISE EXCEPTION 'This expense is on an issued invoice and can''t be changed.';
  END IF;
  IF NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An expense stays on its Matter.';
  END IF;
  IF NEW.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     AND NOT EXISTS (SELECT 1 FROM huis.invoices i WHERE i.id = NEW.invoice_id AND i.matter_id = NEW.matter_id AND i.status = 'draft') THEN
    RAISE EXCEPTION 'An expense goes only on a draft invoice of its own Matter.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_guard BEFORE INSERT OR UPDATE OR DELETE ON huis.expenses FOR EACH ROW EXECUTE FUNCTION huis.expense_guard();

ALTER TABLE huis.time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.time_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.expenses FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.time_entries, huis.expenses TO huis_app;
GRANT SELECT, UPDATE ON huis.time_entries, huis.expenses TO huis_security;
GRANT SELECT ON huis.users, huis.matters TO huis_security;

-- Firm staff who can see the Matter see its time; people record their own (billing staff anyone's), and change
-- their own (billing staff and the Matter's invoicers any). (Every change rule repeats the read conditions.)
CREATE POLICY time_entries_select ON huis.time_entries FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id));
CREATE POLICY time_entries_insert ON huis.time_entries FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
              AND (user_id = huis.current_user_id() OR huis.is_billing_manager())
              AND EXISTS (SELECT 1 FROM huis.users u WHERE u.id = user_id AND huis.is_internal_role(u.role)));
CREATE POLICY time_entries_update ON huis.time_entries FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
         AND (user_id = huis.current_user_id() OR huis.can_invoice_matter(matter_id)))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
              AND (user_id = huis.current_user_id() OR huis.can_invoice_matter(matter_id))
              AND EXISTS (SELECT 1 FROM huis.users u WHERE u.id = user_id AND huis.is_internal_role(u.role)));
CREATE POLICY time_entries_delete ON huis.time_entries FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
         AND (user_id = huis.current_user_id() OR huis.can_invoice_matter(matter_id)));

CREATE POLICY expenses_select ON huis.expenses FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id));
CREATE POLICY expenses_insert ON huis.expenses FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id));
CREATE POLICY expenses_update ON huis.expenses FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
         AND (created_by = huis.current_user_id() OR huis.can_invoice_matter(matter_id)))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id));
CREATE POLICY expenses_delete ON huis.expenses FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
         AND (created_by = huis.current_user_id() OR huis.can_invoice_matter(matter_id)));

-- ---------------------------------------------------------------------------
-- Invoice rules
-- ---------------------------------------------------------------------------
-- A draft is created for the Matter's own client; only its notes and due date change by hand. Issuing,
-- voiding and payments go through the functions below.
CREATE FUNCTION huis.invoice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  IF current_user = 'huis_security' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := huis.current_user_id();
    NEW.created_at := clock_timestamp();
    NEW.status := 'draft'; NEW.number := NULL; NEW.issued_on := NULL; NEW.time_cents := NULL; NEW.expense_cents := NULL;
    NEW.total_cents := NULL; NEW.issued_by := NULL; NEW.voided_by := NULL; NEW.voided_at := NULL;
    NEW.client_id := (SELECT m.client_id FROM huis.matters m WHERE m.id = NEW.matter_id);
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'An issued invoice can''t be changed; void it and issue a new one.'; END IF;
  IF NEW.status <> OLD.status OR NEW.number IS DISTINCT FROM OLD.number OR NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id
     OR NEW.client_id <> OLD.client_id OR NEW.issued_on IS DISTINCT FROM OLD.issued_on OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
     OR NEW.time_cents IS DISTINCT FROM OLD.time_cents OR NEW.expense_cents IS DISTINCT FROM OLD.expense_cents
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.voided_by IS DISTINCT FROM OLD.voided_by OR NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    RAISE EXCEPTION 'Issue or void an invoice with its buttons.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard BEFORE INSERT OR UPDATE ON huis.invoices FOR EACH ROW EXECUTE FUNCTION huis.invoice_guard();

-- A draft can be deleted (its items go back to unbilled); an issued invoice can only be voided.
CREATE FUNCTION huis.invoice_delete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'An issued invoice can''t be deleted; void it instead.'; END IF;
  UPDATE huis.time_entries SET invoice_id = NULL WHERE invoice_id = OLD.id;
  UPDATE huis.expenses SET invoice_id = NULL WHERE invoice_id = OLD.id;
  RETURN OLD;
END $$;
ALTER FUNCTION huis.invoice_delete_guard() OWNER TO huis_security;
CREATE TRIGGER invoices_delete_guard BEFORE DELETE ON huis.invoices FOR EACH ROW EXECUTE FUNCTION huis.invoice_delete_guard();

ALTER TABLE huis.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.invoice_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.invoice_payments FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.invoices TO huis_app;
GRANT SELECT ON huis.invoice_lines, huis.invoice_payments TO huis_app;
GRANT SELECT, INSERT, UPDATE ON huis.invoices, huis.invoice_lines, huis.invoice_payments TO huis_security;

-- A client (or other outside person) on the Matter sees its issued invoices, never drafts.
CREATE FUNCTION huis.client_sees_invoice(p_matter_id uuid, p_status text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_status <> 'draft' AND huis.app_role() = 'client' AND huis.can_see_matter(p_matter_id)
$$;
GRANT EXECUTE ON FUNCTION huis.client_sees_invoice(uuid, text) TO huis_app;

CREATE POLICY invoices_select ON huis.invoices FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND (huis.dna_readable(matter_id) OR huis.client_sees_invoice(matter_id, status)));
CREATE POLICY invoices_insert ON huis.invoices FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.can_invoice_matter(matter_id));
CREATE POLICY invoices_update ON huis.invoices FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_invoice_matter(matter_id))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.can_invoice_matter(matter_id));
CREATE POLICY invoices_delete ON huis.invoices FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_invoice_matter(matter_id) AND status = 'draft');

CREATE POLICY invoice_lines_select ON huis.invoice_lines FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND EXISTS (SELECT 1 FROM huis.invoices i WHERE i.id = invoice_id));
-- Payments: firm staff on the Matter, and the client for their own issued invoices.
CREATE POLICY invoice_payments_select ON huis.invoice_payments FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND EXISTS (SELECT 1 FROM huis.invoices i WHERE i.id = invoice_id));

-- Issue a draft: next number, every line copied as the client will see it, totals fixed, items locked.
CREATE FUNCTION huis.issue_invoice(p_invoice_id uuid, p_issued_on date, p_due_on date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE i huis.invoices; v_year int; v_seq int; v_number text; v_time bigint; v_exp bigint;
BEGIN
  SELECT * INTO i FROM huis.invoices WHERE id = p_invoice_id AND firm_id = huis.current_firm_id() FOR UPDATE;
  IF NOT FOUND OR NOT huis.can_invoice_matter(i.matter_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF i.status <> 'draft' THEN RAISE EXCEPTION 'This invoice has already been issued.'; END IF;
  IF p_issued_on IS NULL OR p_due_on IS NULL OR p_due_on < p_issued_on OR p_issued_on > current_date + 1 OR p_issued_on < current_date - 366 THEN
    RAISE EXCEPTION 'Check the invoice and due dates.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM huis.time_entries WHERE invoice_id = i.id) AND NOT EXISTS (SELECT 1 FROM huis.expenses WHERE invoice_id = i.id) THEN
    RAISE EXCEPTION 'There''s nothing on this invoice yet.';
  END IF;
  INSERT INTO huis.invoice_lines (firm_id, invoice_id, position, kind, line_date, who, description, tenths, rate_cents, amount_cents)
  SELECT i.firm_id, i.id, row_number() OVER (ORDER BY (k = 'expense'), d, created_at, id), k, d, who, description, tenths, rate, amount
    FROM (
      SELECT 'time' AS k, t.work_date AS d, u.full_name AS who, t.description, huis.billed_tenths(t.minutes) AS tenths,
             coalesce(t.rate_cents, 0) AS rate, huis.time_amount(t.minutes, t.rate_cents) AS amount, t.created_at, t.id
        FROM huis.time_entries t JOIN huis.users u ON u.id = t.user_id
       WHERE t.invoice_id = i.id AND t.billable
      UNION ALL
      SELECT 'expense', e.incurred_on, '', e.description, NULL, NULL, e.amount_cents, e.created_at, e.id
        FROM huis.expenses e WHERE e.invoice_id = i.id AND e.billable
    ) x;
  SELECT coalesce(sum(amount_cents) FILTER (WHERE kind = 'time'), 0), coalesce(sum(amount_cents) FILTER (WHERE kind = 'expense'), 0)
    INTO v_time, v_exp FROM huis.invoice_lines WHERE invoice_id = i.id;
  v_year := extract(year FROM p_issued_on)::int;
  INSERT INTO huis.invoice_counters (firm_id, year, last) VALUES (i.firm_id, v_year, 1)
    ON CONFLICT (firm_id, year) DO UPDATE SET last = huis.invoice_counters.last + 1
    RETURNING last INTO v_seq;
  v_number := format('INV-%s-%s', v_year, lpad(v_seq::text, 4, '0'));
  UPDATE huis.invoices SET status = 'issued', number = v_number, issued_on = p_issued_on, due_on = p_due_on,
         time_cents = v_time, expense_cents = v_exp, total_cents = v_time + v_exp, issued_by = huis.current_user_id()
   WHERE id = i.id;
  RETURN v_number;
END $$;

-- Void an issued invoice: it stays (marked void, its lines and number kept); its items return to unbilled.
CREATE FUNCTION huis.void_invoice(p_invoice_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE i huis.invoices;
BEGIN
  SELECT * INTO i FROM huis.invoices WHERE id = p_invoice_id AND firm_id = huis.current_firm_id() FOR UPDATE;
  IF NOT FOUND OR NOT huis.can_invoice_matter(i.matter_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF i.status <> 'issued' THEN RAISE EXCEPTION 'Only an issued, unpaid invoice can be voided.'; END IF;
  IF EXISTS (SELECT 1 FROM huis.invoice_payments WHERE invoice_id = i.id) THEN
    RAISE EXCEPTION 'This invoice has payments recorded against it, so it can''t be voided.';
  END IF;
  UPDATE huis.invoices SET status = 'void', voided_by = huis.current_user_id(), voided_at = clock_timestamp() WHERE id = i.id;
  UPDATE huis.time_entries SET invoice_id = NULL WHERE invoice_id = i.id;
  UPDATE huis.expenses SET invoice_id = NULL WHERE invoice_id = i.id;
END $$;

-- Record a payment received (outside Huis). Paid in full marks the invoice paid.
CREATE FUNCTION huis.record_invoice_payment(p_invoice_id uuid, p_amount_cents bigint, p_received_on date, p_method text, p_reference text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE i huis.invoices; v_paid bigint;
BEGIN
  SELECT * INTO i FROM huis.invoices WHERE id = p_invoice_id AND firm_id = huis.current_firm_id() FOR UPDATE;
  IF NOT FOUND OR NOT huis.can_invoice_matter(i.matter_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF i.status <> 'issued' THEN RAISE EXCEPTION 'Payments are recorded against an issued, unpaid invoice.'; END IF;
  IF p_received_on IS NULL OR p_received_on > current_date + 1 OR p_received_on < i.issued_on - 366 THEN RAISE EXCEPTION 'Check the date received.'; END IF;
  v_paid := coalesce((SELECT sum(amount_cents) FROM huis.invoice_payments WHERE invoice_id = i.id), 0);
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR v_paid + p_amount_cents > i.total_cents THEN
    RAISE EXCEPTION 'The payment can''t be more than what''s still owed.';
  END IF;
  INSERT INTO huis.invoice_payments (firm_id, invoice_id, amount_cents, received_on, method, reference, recorded_by)
    VALUES (i.firm_id, i.id, p_amount_cents, p_received_on, p_method, left(coalesce(p_reference, ''), 100), huis.current_user_id());
  IF v_paid + p_amount_cents = i.total_cents THEN
    UPDATE huis.invoices SET status = 'paid' WHERE id = i.id;
    RETURN 'paid';
  END IF;
  RETURN 'issued';
END $$;

ALTER FUNCTION huis.issue_invoice(uuid, date, date) OWNER TO huis_security;
ALTER FUNCTION huis.void_invoice(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.record_invoice_payment(uuid, bigint, date, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.issue_invoice(uuid, date, date), huis.void_invoice(uuid),
  huis.record_invoice_payment(uuid, bigint, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.issue_invoice(uuid, date, date), huis.void_invoice(uuid),
  huis.record_invoice_payment(uuid, bigint, date, text, text) TO huis_app;
GRANT USAGE ON SEQUENCE huis.audit_events_id_seq TO huis_security;
