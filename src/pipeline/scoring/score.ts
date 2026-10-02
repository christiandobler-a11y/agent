import { RUBRIC_CRITERIA, RUBRIC_LABELS, type AuditOutput } from "../audit/schema.js";
import type { ScoringConfig } from "./config.js";

/**
 * Avelio Lead Score (ARCHITECTURE.md 7): rein, deterministisch, voll unit-getestet. Das LLM liefert nur die
 * Rubrik (1–5 mit Beleg); alle Punkte rechnet dieser Code. Jede Position landet mit Quelle in der Aufschlüsselung.
 */

export interface ScoreInput {
  segment: "WEBSITE" | "NO_WEBSITE";
  /** Wirtschaftlicher Branchenwert 1–5 aus config/branches.yaml, `null` = unbekannte Branche. */
  branchValue: number | null;
  places: {
    rating: number | null;
    reviewCount: number | null;
    businessStatus: string | null;
    photoCount: number | null;
  };
  /** Fakten aus dem Crawl (null ohne Website). */
  site: {
    https: boolean;
    tls_valid: boolean;
    has_viewport_meta: boolean;
    mobile_too_wide: boolean;
    tel_links: string[];
    has_contact_form: boolean;
    copyright_year: number | null;
    layout_tables: number;
    cms: string | null;
  } | null;
  psiPerformance: number | null;
  audit: AuditOutput | null;
  contacts: { ownerNamed: boolean; email: boolean; phone: boolean };
  now: Date;
}

export type Source = "objektiv" | "rubrik" | "konfiguration" | "berechnet";

export interface ScoreItem {
  label: string;
  points: number;
  max: number;
  source: Source;
  detail: string;
}

export interface Dimension {
  key: "business" | "website" | "potential" | "gap" | "reach";
  label: string;
  points: number;
  max: number;
  items: ScoreItem[];
}

/** Gründe entsprechen den Schlüsseln in config/recheck.yaml (skipped.*). */
export type KnockoutReason = "closed" | "reputation" | "website_good";

export interface ScoreResult {
  version: string;
  total: number;
  dimensions: Dimension[];
  knockout: { reason: KnockoutReason; detail: string } | null;
  qualified: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const fmtRating = (r: number) => r.toFixed(1).replace(".", ",");

function dimension(key: Dimension["key"], label: string, max: number, items: ScoreItem[]): Dimension {
  const raw = items.reduce((s, i) => s + i.points, 0);
  return { key, label, max, points: round1(Math.min(max, raw)), items };
}

function business(input: ScoreInput, c: ScoringConfig["dimensions"]["business"]): Dimension {
  const { rating, reviewCount, photoCount } = input.places;
  const r = rating ?? 0;
  const n = reviewCount ?? 0;
  const photos = photoCount ?? 0;
  const ratingPts = c.rating.max * clamp01((r - c.rating.from) / (c.rating.full - c.rating.from));
  const reviewPts = n > 0 ? c.reviews.max * clamp01(Math.log(n + 1) / Math.log(c.reviews.full + 1)) : 0;
  const photoPts = c.photos.max * clamp01(photos / c.photos.full);
  return dimension("business", "Business-Gesundheit", c.max, [
    {
      label: "Google-Bewertung",
      points: round1(ratingPts),
      max: c.rating.max,
      source: "objektiv",
      detail:
        rating === null
          ? "keine Bewertung"
          : `${fmtRating(r)}★ (volle Punkte ab ${fmtRating(c.rating.full)}★)`,
    },
    {
      label: "Anzahl Bewertungen",
      points: round1(reviewPts),
      max: c.reviews.max,
      source: "objektiv",
      detail: `${n} Bewertungen (volle Punkte ab ${c.reviews.full})`,
    },
    {
      label: "Fotos bei Google",
      points: round1(photoPts),
      max: c.photos.max,
      source: "objektiv",
      detail: `${photos} Fotos`,
    },
  ]);
}

function website(input: ScoreInput, c: ScoringConfig["dimensions"]["website"]): Dimension {
  if (input.segment === "NO_WEBSITE") {
    return dimension("website", "Website-Chance", c.max, [
      {
        label: "Keine Website",
        points: c.no_website_points,
        max: c.max,
        source: "objektiv",
        detail: "Firma hat keine eigene Website (oder nur ein Social-Media-Profil)",
      },
    ]);
  }

  const o = c.objective;
  const s = input.site;
  const perf = input.psiPerformance;
  const objective: ScoreItem[] = [];
  const add = (hit: boolean, label: string, points: number, detail: string) => {
    if (hit && points > 0) objective.push({ label, points, max: points, source: "objektiv", detail });
  };
  if (perf !== null) {
    add(perf < 50, "PageSpeed mobil schwach", o.psi_performance_below_50, `Performance ${perf}/100`);
    add(perf < 30, "PageSpeed mobil sehr schwach", o.psi_performance_below_30, `Performance ${perf}/100`);
  }
  if (s) {
    add(!s.https, "Kein HTTPS", o.no_https, "Seite wird unverschlüsselt ausgeliefert");
    add(s.https && !s.tls_valid, "Zertifikat ungültig", o.invalid_certificate, "Browser zeigen eine Warnung");
    add(!s.has_viewport_meta, "Nicht für Handys ausgelegt", o.no_viewport, "kein Viewport-Meta-Tag");
    add(s.mobile_too_wide, "Mobil zu breit", o.mobile_too_wide, "Seite wird auf dem Handy verkleinert");
    add(s.tel_links.length === 0, "Kein Anruf-Link", o.no_tel_link, "Telefonnummer nicht antippbar");
    add(!s.has_contact_form, "Kein Kontaktformular", o.no_contact_form, "keine Anfrage über die Website");
    const age = s.copyright_year === null ? null : input.now.getUTCFullYear() - s.copyright_year;
    add(
      age !== null && age >= o.copyright_older_than_years.years,
      "Veraltetes Copyright",
      o.copyright_older_than_years.points,
      `© ${s.copyright_year}`,
    );
    add(s.layout_tables > 0, "Tabellen-Layout", o.layout_tables, "Aufbau mit Tabellen wie um 2005");
    add(
      s.cms !== null && c.outdated_builders.includes(s.cms),
      "Einfacher Baukasten",
      o.outdated_builder,
      s.cms ?? "",
    );
  }
  const objectiveRaw = objective.reduce((sum, i) => sum + i.points, 0);
  const objectivePts = Math.min(c.objective_max, objectiveRaw);
  // Kappung sichtbar machen, damit die Summe der Positionen zur Dimension passt.
  if (objectiveRaw > c.objective_max) {
    objective.push({
      label: "Kappung objektive Punkte",
      points: round1(objectivePts - objectiveRaw),
      max: 0,
      source: "konfiguration",
      detail: `höchstens ${c.objective_max} objektive Punkte`,
    });
  }

  const rubric: ScoreItem[] = [];
  if (input.audit) {
    const per = c.rubric_max / RUBRIC_CRITERIA.length;
    for (const key of RUBRIC_CRITERIA) {
      const item = input.audit.rubric[key];
      rubric.push({
        label: RUBRIC_LABELS[key],
        points: round1(((5 - item.score) / 4) * per),
        max: round1(per),
        source: "rubrik",
        detail: `${item.score}/5 – ${item.evidence}`,
      });
    }
  }
  return dimension("website", "Website-Chance", c.max, [...objective, ...rubric]);
}

function potential(input: ScoreInput, c: ScoringConfig["dimensions"]["potential"]): Dimension {
  const value = input.branchValue;
  const branchPts = value === null ? 3 : (c.branch_value * Math.max(1, Math.min(5, value))) / 5;
  const items: ScoreItem[] = [
    {
      label: "Branchenwert",
      points: round1(branchPts),
      max: c.branch_value,
      source: "konfiguration",
      detail: value === null ? "Branche unbekannt" : `${value}/5 (config/branches.yaml)`,
    },
  ];
  const services = input.audit?.commercial.high_value_services ?? [];
  items.push({
    label: "Hochpreisige Leistungen",
    points: round1(Math.min(c.high_value_services.max, services.length * c.high_value_services.per_service)),
    max: c.high_value_services.max,
    source: "rubrik",
    detail: services.length > 0 ? services.join(", ") : "keine erkannt",
  });
  const team = input.audit?.commercial.team_size ?? "unknown";
  const signals = input.audit?.commercial.size_signals ?? [];
  items.push({
    label: "Größe",
    points: c.team_size[team],
    max: Math.max(...Object.values(c.team_size)),
    source: "rubrik",
    detail: `${team}${signals.length > 0 ? ` (${signals.join("; ")})` : ""}`,
  });
  return dimension("potential", "Wirtschaftliches Potenzial", c.max, items);
}

function gap(
  a: Dimension,
  b: Dimension,
  input: ScoreInput,
  c: ScoringConfig["dimensions"]["gap"],
): Dimension {
  const aNorm = a.points / a.max;
  const bNorm = b.points / b.max;
  const gapPts = c.gap_max * Math.min(aNorm, bNorm);
  const strong = (input.audit?.findings ?? []).filter((f) => f.severity !== "low").length;
  const e = c.explainable;
  const explainPts =
    input.segment === "NO_WEBSITE"
      ? e.points // "Sie werden online nicht gefunden" ist für sich erklärbar
      : strong >= e.min_findings
        ? e.points
        : strong >= e.partial_findings
          ? e.partial_points
          : 0;
  return dimension("gap", "Reputations-Website-Lücke", c.max, [
    {
      label: "Starke Firma, schwache Website",
      points: round1(gapPts),
      max: c.gap_max,
      source: "berechnet",
      detail: `min(Business ${Math.round(aNorm * 100)} %, Website-Chance ${Math.round(bNorm * 100)} %)`,
    },
    {
      label: "Zeigbare Probleme",
      points: explainPts,
      max: e.points,
      source: input.segment === "NO_WEBSITE" ? "objektiv" : "rubrik",
      detail: input.segment === "NO_WEBSITE" ? "keine Website" : `${strong} deutliche Befunde`,
    },
  ]);
}

function reach(input: ScoreInput, c: ScoringConfig["dimensions"]["reach"]): Dimension {
  const k = input.contacts;
  const form = input.site?.has_contact_form ?? false;
  const item = (hit: boolean, label: string, max: number, yes: string, no: string): ScoreItem => ({
    label,
    points: hit ? max : 0,
    max,
    source: "objektiv",
    detail: hit ? yes : no,
  });
  return dimension("reach", "Erreichbarkeit", c.max, [
    item(k.ownerNamed, "Inhaber namentlich", c.owner_named, "im Impressum genannt", "nicht gefunden"),
    item(k.email, "E-Mail", c.email, "vorhanden", "keine gefunden"),
    item(k.phone, "Telefon", c.phone, "vorhanden", "keine gefunden"),
    item(form, "Kontaktformular", c.contact_form, "vorhanden", "keins"),
  ]);
}

function knockout(input: ScoreInput, websiteChance: number, config: ScoringConfig): ScoreResult["knockout"] {
  const { rating, reviewCount, businessStatus } = input.places;
  const k = config.knockouts;
  if (businessStatus && businessStatus !== "OPERATIONAL") {
    return { reason: "closed", detail: `Google-Status ${businessStatus}` };
  }
  const n = reviewCount ?? 0;
  if (n < k.min_reviews) return { reason: "reputation", detail: `zu wenige Bewertungen (${n})` };
  if (
    rating !== null &&
    rating < k.min_rating_with_reviews.rating &&
    n >= k.min_rating_with_reviews.reviews
  ) {
    return {
      reason: "reputation",
      detail: `Reputation zu schwach (${fmtRating(rating)}★ bei ${n} Bewertungen)`,
    };
  }
  if (input.segment === "WEBSITE" && input.audit && websiteChance < k.min_website_chance) {
    return {
      reason: "website_good",
      detail: `Website bereits modern und technisch gut (Website-Chance ${String(websiteChance).replace(".", ",")}/${config.dimensions.website.max})`,
    };
  }
  return null;
}

export function scoreLead(input: ScoreInput, config: ScoringConfig): ScoreResult {
  const d = config.dimensions;
  const a = business(input, d.business);
  const b = website(input, d.website);
  const c = potential(input, d.potential);
  const g = gap(a, b, input, d.gap);
  const e = reach(input, d.reach);
  const dimensions = [a, b, c, g, e];
  const total = Math.round(dimensions.reduce((sum, dim) => sum + dim.points, 0));
  const ko = knockout(input, b.points, config);
  return {
    version: config.version,
    total,
    dimensions,
    knockout: ko,
    qualified: ko === null && total >= config.qualify_min_total,
  };
}
