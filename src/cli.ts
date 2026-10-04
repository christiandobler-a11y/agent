import { checkKeys } from "./config/check.js";
import { loadDotEnv, loadEnv, requireKeys } from "./config/env.js";
import { createDb, describeDbError } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { dbStatus } from "./db/status.js";
import { costReport } from "./db/costs.js";
import { loadMailConfig } from "./outreach/mail.js";
import { seedBoxesFromEnv } from "./outreach/seed.js";
import { loadOutreachConfig } from "./outreach/config.js";
import { recipient, salutationLine } from "./outreach/draft.js";
import { personFromCompanyName } from "./outreach/names.js";
import { loadAutopilotConfig } from "./autopilot/plan.js";
import { createBudgetGuard } from "./llm/budget.js";
import { loadModelsConfig } from "./llm/config.js";
import { createAnthropicMessages, createLlmGateway } from "./llm/gateway.js";
import { loadBranches } from "./pipeline/research/branches.js";
import { loadGateRules } from "./pipeline/research/gate.js";
import { createPlacesClient } from "./pipeline/research/places.js";
import { createPrefilter } from "./pipeline/research/prefilter.js";
import { loadRecheckRules } from "./pipeline/research/recheck.js";
import { loadResearchConfig, runResearch, type ResearchStats } from "./pipeline/research/run.js";
import { loadRegion } from "./pipeline/research/tiling.js";
import { parseCrawlArgs, parseResearchArgs } from "./cli-args.js";
import { companiesToCrawl, findCompany, type Company } from "./db/companies.js";
import { createBrowserCrawler } from "./pipeline/crawl/browser.js";
import { loadCrawlConfig } from "./pipeline/crawl/config.js";
import { createPageSpeedClient } from "./pipeline/crawl/pagespeed.js";
import { crawlCompany, type CrawlOutcome } from "./pipeline/crawl/run.js";
import { mapLimit } from "./util/mapLimit.js";
import { audit, explain, score } from "./cliLeads.js";
import { angebot, letter, prototype, teaser } from "./cliOutreach.js";
import { chat, coverage, failed, runs, search, worker } from "./cliQueue.js";
import { calibrate } from "./cliCalibrate.js";

const ICONS = { ok: "✔", missing: "–", error: "✘" } as const;

async function checkEnv(): Promise<number> {
  const results = await checkKeys(loadEnv());
  for (const r of results) {
    console.log(`${ICONS[r.status]} ${r.name.padEnd(28)} ${r.detail}`);
  }
  return results.some((r) => r.status === "error") ? 1 : 0;
}

async function runMigrations(): Promise<number> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 2 });
  try {
    const applied = await migrate(db);
    console.log(
      applied.length > 0 ? `Angewendet: ${applied.join(", ")}` : "Datenbank ist auf dem neuesten Stand.",
    );
    return 0;
  } finally {
    await db.end();
  }
}

const usd = (n: number) => `${n.toFixed(3).replace(".", ",")} $`;
const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "–";

const STOP_LABELS: Record<NonNullable<ResearchStats["stopped_because"]>, string> = {
  goal_reached: "Ziel erreicht",
  tiles_exhausted: "alle Orte abgesucht",
  request_limit: "Limit für Places-Anfragen erreicht (config/research.yaml)",
  budget_exceeded: "Budget erreicht",
};

function printStats(s: ResearchStats) {
  console.log(`
Kacheln:        ${s.tiles_searched}/${s.tiles_total} · Places-Anfragen ${s.places_requests} (~${usd(s.places_cost_usd)})
Treffer:        ${s.results} · außerhalb der Region ${s.out_of_region} · doppelt im Lauf ${s.duplicates_in_run}
Firmen:         neu ${s.new_companies} · bekannt ${s.known_companies} (davon noch nicht fällig ${s.known_not_due})
Gate:           ${counts(s.gate_skipped)}
Prefilter:      ${counts(s.prefilter_skipped)} · Fehler ${s.prefilter_errors} · LLM ${usd(s.llm_cost_usd)}
Bestanden:      ${s.passed} (Ziel ${s.goal}) · Ende: ${s.stopped_because ? STOP_LABELS[s.stopped_because] : (s.error ?? "?")}`);
  if (s.stopped_because === "budget_exceeded" && s.error) {
    console.log(
      `\n${s.error}\nNoch nicht geprüfte Firmen bleiben NEW und werden beim nächsten Lauf fertig geprüft.`,
    );
  }
}

async function research(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseResearchArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const env = loadEnv();
  const keys = requireKeys(env, ["DATABASE_URL", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]);
  const region = loadRegion(parsed.region);
  const db = createDb(keys.DATABASE_URL, { max: 6 });
  try {
    const models = loadModelsConfig();
    const budget = createBudgetGuard(db, models.budget);
    const llm = createLlmGateway({
      db,
      messages: createAnthropicMessages(keys.ANTHROPIC_API_KEY),
      models,
      budget,
    });
    console.log(
      `Suche "${parsed.term}" in ${region.name}, ${parsed.complete ? "komplett (alle Orte)" : `Ziel ${parsed.target}`} …`,
    );
    const result = await runResearch(
      {
        db,
        places: createPlacesClient({ apiKey: keys.GOOGLE_API_KEY }),
        prefilter: createPrefilter(llm),
        branches: loadBranches(),
        gate: loadGateRules(),
        recheck: loadRecheckRules(),
        config: loadResearchConfig(),
        budget,
        onProgress: (m) => console.log(`  ${m}`),
      },
      { term: parsed.term, region, target: parsed.target, requestedBy: "cli", complete: parsed.complete },
    );
    console.log(`\nSuchlauf ${result.run.id}`);
    for (const c of result.passed) {
      const site = c.website_url ?? "keine Website";
      console.log(`  ✔ ${c.name.padEnd(40)} ${(c.city ?? "").padEnd(22)} ${site}`);
    }
    printStats(result.stats);
    return 0;
  } finally {
    await db.end();
  }
}

async function showDbStatus(): Promise<number> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 1 });
  try {
    const status = await dbStatus(db);
    console.log(`Schema ${status.schema}`);
    console.log(
      `Migrationen: ${status.migrations.map((m) => m.version).join(", ") || "keine – erst npm run migrate"}`,
    );
    let unprotected = 0;
    for (const t of status.tables) {
      const open = !t.rls || t.anonCanRead === true;
      if (open) unprotected++;
      const access =
        t.anonCanRead === null ? "" : t.anonCanRead ? " · Data API: OFFEN" : " · Data API: gesperrt";
      console.log(
        `  ${open ? "✘" : "✔"} ${t.name.padEnd(20)} ${String(t.rows).padStart(7)} Zeilen · RLS ${t.rls ? "an" : "AUS"}${access}`,
      );
    }
    if (unprotected > 0) console.log(`\n${unprotected} Tabelle(n) ungeschützt – npm run migrate ausführen.`);
    return unprotected > 0 || status.migrations.length === 0 ? 1 : 0;
  } finally {
    await db.end();
  }
}

async function showCosts(): Promise<number> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const { budget } = loadModelsConfig();
  const db = createDb(DATABASE_URL, { max: 1 });
  try {
    const report = await costReport(db);
    const line = (label: string, spent: number, limit: number) =>
      `${label.padEnd(8)} ${usd(spent).padStart(10)} von ${usd(limit)} (${Math.round((spent / limit) * 100)} %)`;
    console.log(line("Heute", report.today, budget.daily_usd));
    console.log(line("Monat", report.month, budget.monthly_usd));
    console.log("\nLetzte 7 Tage nach Rolle bzw. Dienst:");
    if (report.rows.length === 0) console.log("  noch keine Kosten");
    for (const r of report.rows) {
      const errors = r.errors > 0 ? ` · ${r.errors} Fehler` : "";
      console.log(
        `  ${r.day}  ${`${r.source}/${r.name}`.padEnd(16)} ${String(r.calls).padStart(5)} Aufrufe ${usd(r.cost_usd).padStart(10)}${errors}`,
      );
    }
    return 0;
  } finally {
    await db.end();
  }
}

function printCrawl(company: Company, outcome: CrawlOutcome) {
  const head = `${company.name} (${company.city ?? "?"})`;
  switch (outcome.kind) {
    case "no_website":
      console.log(`– ${head}: keine Website hinterlegt`);
      return;
    case "social_only":
      console.log(
        `– ${head}: nur Social-Media-Profil (${outcome.snapshot.url}) → als „ohne Website“ markiert`,
      );
      return;
    case "failed":
      console.log(`✘ ${head}: ${outcome.errorKind} – ${outcome.error.slice(0, 160)}`);
      return;
    case "ok": {
      const f = outcome.facts;
      const p = outcome.psi;
      const imp = f.impressum;
      const yes = (b: boolean) => (b ? "ja" : "nein");
      console.log(`✔ ${head}
    URL:        ${outcome.snapshot.final_url}${f.https ? "" : "  (ohne HTTPS)"}${f.tls_valid ? "" : "  (Zertifikat ungültig!)"}
    PageSpeed:  ${p ? `Performance ${p.performance ?? "?"} · SEO ${p.seo ?? "?"} · Best Practices ${p.best_practices ?? "?"} · Barrierefreiheit ${p.accessibility ?? "?"}` : `– (${outcome.psiError ?? "nicht abgefragt"})`}
    Technik:    ${f.cms ?? "CMS unbekannt"} · © ${f.copyright_year ?? "?"} · Viewport ${yes(f.has_viewport_meta)} · mobil zu breit ${f.mobile_too_wide ? `ja (+${f.mobile_overflow_px} px)` : "nein"}
    Kontakt:    tel-Link ${yes(f.tel_links.length > 0)} · Formular ${yes(f.has_contact_form)} · CTAs: ${f.cta_texts.slice(0, 3).join(", ") || "keine"}
    Impressum:  ${imp ? `${imp.person ? `${imp.person} (${imp.role})` : "keine Person erkannt"} · ${imp.emails[0] ?? "keine E-Mail"} · ${imp.phones[0] ?? "kein Telefon"}` : "nicht gefunden"}
    Screenshots: ${outcome.snapshot.screenshot_desktop}
                 ${outcome.snapshot.screenshot_mobile}`);
    }
  }
}

async function crawl(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCrawlArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const env = loadEnv();
  const { DATABASE_URL } = requireKeys(env, ["DATABASE_URL"]);
  const config = loadCrawlConfig();
  const db = createDb(DATABASE_URL, { max: config.concurrency + 2 });
  try {
    const companies =
      parsed.mode === "one"
        ? [await findCompany(db, parsed.ref)].filter((c): c is Company => c !== null)
        : parsed.mode === "leads"
          ? (
              await db.query<Company>(
                `select * from companies where segment is distinct from 'NO_WEBSITE' and website_url is not null
                   and status in ('QUALIFIED', 'READY_FOR_CONTACT', 'CONTACTED', 'REPLIED', 'INTERESTED', 'PROTOTYPE')
                 order by current_score desc nulls last`,
              )
            ).rows
          : await companiesToCrawl(db, parsed.limit);
    if (companies.length === 0) {
      console.log(parsed.mode === "one" ? `Keine Firma gefunden für "${parsed.ref}".` : "Nichts zu crawlen.");
      return parsed.mode === "one" ? 1 : 0;
    }
    if (!env.GOOGLE_API_KEY) console.log("Hinweis: GOOGLE_API_KEY fehlt, PageSpeed wird übersprungen.");
    const crawler = await createBrowserCrawler({
      config,
      executablePath: process.env.CHROMIUM_PATH,
      proxy: process.env.HTTPS_PROXY,
    });
    try {
      const deps = {
        db,
        crawler,
        pagespeed: env.GOOGLE_API_KEY ? createPageSpeedClient({ apiKey: env.GOOGLE_API_KEY }) : null,
        config,
        recheck: loadRecheckRules(),
      };
      console.log(`Crawle ${companies.length} Firma/Firmen …\n`);
      const outcomes = await mapLimit(companies, config.concurrency, async (c) => {
        const outcome = await crawlCompany(deps, c);
        printCrawl(c, outcome);
        return outcome;
      });
      const ok = outcomes.filter((o) => o.kind === "ok").length;
      console.log(`\n${ok} von ${outcomes.length} erfolgreich. Screenshots unter ${config.screenshot_dir}/`);
      return 0;
    } finally {
      await crawler.close();
    }
  } finally {
    await db.end();
  }
}

/** Kontroll-Postfächer prüfen: Login per IMAP, Spam-Ordner gefunden? Verschickt nichts, gibt keine Passwörter aus. */
async function seedCheck(): Promise<number> {
  const boxes = seedBoxesFromEnv(loadEnv(), loadMailConfig());
  if (boxes.length === 0) {
    console.log(
      "Keine Kontroll-Postfächer eingerichtet (SEED_1_ADDRESS/SEED_1_PASSWORD in der .env, docs/DEPLOY.md 14).",
    );
    return 1;
  }
  let failed = 0;
  for (const box of boxes) {
    try {
      await box.locate("<avelio-test@avelio.digital>");
      console.log(`✔ ${box.label} (${box.address}): Login ok`);
    } catch (err) {
      failed++;
      console.log(`✘ ${box.label} (${box.address}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Offene IMAP-Verbindungen dürfen die Konsole nicht festhalten.
  process.exit(failed > 0 ? 1 : 0);
}

/** Anrede der nächsten Kandidaten fürs Morgen-Paket prüfen (ohne LLM, verschickt nichts). */
async function greetings(args: string[]): Promise<number> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const n = Number(args[0] ?? 20) || 20;
  const o = loadOutreachConfig();
  const branches = loadAutopilotConfig().neue_kontakte.branchen ?? [];
  const db = createDb(DATABASE_URL, { max: 1 });
  try {
    const { rows } = await db.query<Company>(
      `select c.* from companies c
        where c.status in ('READY_FOR_CONTACT', 'QUALIFIED')
          and (cardinality($2::text[]) = 0 or c.branch_key = any($2))
          and not exists (select 1 from interactions i
                           where i.company_id = c.id and i.type = 'draft' and i.meta ? 'sent_at')
        order by (c.status = 'READY_FOR_CONTACT') desc, c.current_score desc nulls last limit $1`,
      [n, branches],
    );
    const counts = { persönlich: 0, team: 0 };
    for (const c of rows) {
      const person = await recipient(db, c.id);
      const team = o.team_anrede[c.branch_key ?? ""]?.anrede ?? null;
      const line = salutationLine("sie", person, c.name, team, o.anrede);
      const toTeam = line === team || line.startsWith("Grüß Gott") || line.startsWith("Hallo Team");
      const source = person.salutation
        ? "Frau/Herr aus dem Impressum"
        : person.name
          ? toTeam
            ? "Vorname mehrdeutig"
            : "aus dem Vornamen"
          : personFromCompanyName(c.name)
            ? "aus dem Firmennamen"
            : "kein Name im Impressum";
      if (toTeam) counts.team++;
      else counts.persönlich++;
      console.log(
        `${line.padEnd(34)} ${c.name.slice(0, 45).padEnd(46)} Name: ${person.name ?? "–"} (${source})${person.email ? "" : " · keine Mail"}`,
      );
    }
    console.log(`\n${counts.persönlich} persönlich, ${counts.team} ans Team`);
    return 0;
  } finally {
    await db.end();
  }
}

const commands: Record<string, (args: string[]) => Promise<number>> = {
  anrede: greetings,
  "seed-check": seedCheck,
  search,
  coverage,
  worker,
  chat,
  runs,
  failed,
  audit,
  score,
  explain,
  calibrate,
  crawl,
  letter,
  prototype,
  teaser,
  angebot,
  costs: showCosts,
  "check-env": checkEnv,
  migrate: runMigrations,
  "db-status": showDbStatus,
  research,
};

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const command = name ? commands[name] : undefined;
  if (!command) {
    console.error(`Verwendung: avelio <${Object.keys(commands).join("|")}>`);
    return 2;
  }
  return command(rest);
}

loadDotEnv();
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // Kurze Meldung statt Stacktrace; Details mit DEBUG=1.
  console.error(`Fehler: ${describeDbError(err, process.env.DATABASE_URL)}`);
  if (process.env.DEBUG) console.error(err);
  process.exitCode = 1;
}
