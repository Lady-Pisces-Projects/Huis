import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./helpers";

// The public homepage states prices and trial limits; they must match what the database enforces.
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe("the homepage matches the plans", () => {
  it("states the prices and trial limits the database enforces, and never asks for a demo", async () => {
    const page = await readFile(path.join(__dirname, "../app/page.tsx"), "utf8");
    // createTestDatabase lifts the trial's limits for other tests; read them from the migrations' values instead.
    const pro = (await t.admin.query("SELECT price_cents_per_seat AS m, price_cents_per_seat_year AS y FROM huis.plans WHERE code = 'professional'")).rows[0];
    expect(pro).toEqual({ m: 23700, y: 237000 });
    expect(page).toContain("$237<small>per seat / month");
    expect(page).toContain("$2,370<small>per seat / year");
    const migrations = await readFile(path.join(__dirname, "../db/migrations/0032_stripe.sql"), "utf8");
    expect(migrations).toContain("UPDATE huis.plans SET seat_limit = 1, matter_limit = 1 WHERE code = 'trial'");
    expect(page).toContain("1 seat and 1 Matter");
    expect(page).toContain("2 GB of evidence");
    expect(page).toContain("100 Matter Brain and agent questions");
    expect(page).toContain("7-Day Free Trial");
    expect(page.toLowerCase()).not.toContain("request a demo");
    expect(page.toLowerCase()).not.toContain("most popular");
  });
});
