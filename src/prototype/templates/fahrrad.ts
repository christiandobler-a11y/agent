import { mix, paletteFrom } from "../color.js";
import type { SiteContent, SortimentArt } from "../content.js";

/**
 * Vorlage Fahrradhandel ("fahrrad"): Nachbau von Christians eigenem Prototyp fs-pbg.netlify.app (Fahrrad-Shop
 * Peißenberg), gleiches Markup und Stylesheet (assets/prototype/fahrrad/style.css, Tailwind-Ausgabe des Originals,
 * Schriften Big Shoulders Display und Archivo). Ausgetauscht werden nur Name, Fotos, Texte, Marken, Kontaktdaten und
 * die Akzentfarbe. Weil das Stylesheet nur die Klassen des Originals enthält, hier nur Klassen von dort verwenden.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const telHref = (phone: string) =>
  `tel:${phone
    .replace(/[^\d+]/g, "")
    .replace(/^00/, "+")
    .replace(/^0/, "+49")}`;

const WRAP = "mx-auto w-full max-w-[1400px] px-6 sm:px-10 lg:px-14";
const BTN =
  "inline-flex min-h-11 items-center justify-center gap-2 font-display text-[13px] font-bold uppercase tracking-[0.08em] transition-colors duration-300";

/** Kleines Speichen-Symbol des Originals (Rubriken, Leiste unter dem Hero). */
const wheel = (onDark = false, extra = "") =>
  `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true" class="shrink-0 ${extra}"><circle cx="12" cy="12" r="9" class="${onDark ? "stroke-bone/35" : "stroke-ink/35"}" stroke-width="1.8"></circle><g class="${onDark ? "stroke-bone/35" : "stroke-ink/35"}" stroke-width="1.5" stroke-linecap="round"><line x1="12" y1="12" x2="12" y2="4"></line><line x1="12" y1="12" x2="18.2" y2="15.7"></line><line x1="12" y1="12" x2="5.8" y2="15.7"></line></g><circle cx="12" cy="12" r="2.1" fill="var(--color-magenta)"></circle></svg>`;

const rubric = (n: number, label: string, onDark = false) =>
  `<div class="mb-10 flex items-center gap-3 sm:mb-14"><span class="font-display text-[11px] font-bold tracking-[0.3em] ${onDark ? "text-graphite-soft" : "text-graphite"}">${String(n).padStart(2, "0")}</span>${wheel(onDark)}<span class="font-display text-[11px] font-bold uppercase tracking-[0.3em] ${onDark ? "text-graphite-soft" : "text-graphite"}">${esc(label)}</span></div>`;

/** Bilder der Kategorie-Kacheln aus dem Original (Produktfotos, keine Ladenfotos). */
const CATEGORY_IMAGES: Partial<Record<SortimentArt, string>> = {
  ebike: "img/cat-ebike.webp",
  mtb: "img/cat-mountainbike.webp",
  gravel: "img/cat-gravel.webp",
  rennrad: "img/cat-rennrad.webp",
};

/** Spaltenbreiten der Kacheln (6er-Raster) wie im Original: 4+2, 3+3 … */
export function tileSpans(n: number): number[] {
  const patterns: Record<number, number[]> = {
    1: [6],
    2: [3, 3],
    3: [4, 2, 6],
    4: [4, 2, 3, 3],
    5: [4, 2, 2, 2, 2],
    6: [4, 2, 3, 3, 3, 3],
  };
  return patterns[Math.min(Math.max(n, 1), 6)]!;
}

/** Name als zweizeilige Wortmarke ("FAHRRADWELT" / "HUBER"). */
export function wordmarkLines(name: string): [string, string | null] {
  const words = name.toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [words[0] ?? "", null];
  const cut = Math.ceil(words.length / 2);
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

/** Kopfzeilen: vom LLM, sonst aus dem Nutzen-Satz (letztes Wort = Akzent). */
export function heroLines(c: SiteContent): string[] {
  if (c.heroLines && c.heroLines.length >= 2) return c.heroLines.slice(0, 3);
  const words = c.hero.headline.split(/\s+/);
  const last = words.pop() ?? "";
  return [words.join(" "), last].filter(Boolean);
}

export function renderFahrrad(c: SiteContent): string {
  const p = paletteFrom(c.primary);
  const accent = p.primary;
  const bright = mix(accent, "#ffffff", 0.3);
  const sie = c.form === "sie";
  const phone = c.contact.phone;
  const tel = phone ? telHref(phone) : "#kontakt";
  const [w1, w2] = wordmarkLines(c.name);
  const wordmark = (light: boolean) =>
    `<span class="font-display font-black italic leading-[0.82] tracking-tight ${light ? "text-bone" : "text-ink"}"><span class="block text-[15px] sm:text-[17px]">${esc(w1)}</span>${w2 ? `<span class="block text-[15px] sm:text-[17px]">${esc(w2)}</span>` : ""}</span>`;
  const city = c.city ?? "";
  const heroImage = c.hero.image ?? CATEGORY_IMAGES[c.range?.[0]?.kind ?? "ebike"] ?? "img/cat-ebike.webp";
  const leasing = c.leasing?.offered === true;

  // Kategorie-Kacheln: eigenes Foto, sonst Produktfoto der Kategorie; ohne Bild keine Kachel.
  const gallery = [...c.gallery];
  const tiles = (c.range ?? [])
    .map((r) => ({ ...r, img: CATEGORY_IMAGES[r.kind] ?? gallery.shift() ?? null }))
    .filter((r): r is typeof r & { img: string } => r.img !== null)
    .slice(0, 6);
  let n = 0;
  const num = () => ++n;

  const lines = heroLines(c);
  const h1 = lines
    .map(
      (l, i) =>
        `<span class="block overflow-hidden"><span class="block text-[15vw] ${i === lines.length - 1 ? "italic text-magenta-bright " : ""}sm:text-[9vw] lg:text-[5.4vw]">${esc(l)}</span></span>`,
    )
    .join("");

  const strip = (c.brands && c.brands.length > 0 ? c.brands.slice(0, 6) : c.trust).join(" · ");
  const street = c.contact.address?.split(",")[0]?.trim() ?? "";

  const pillarItems = [...c.trust.slice(0, 4), city].filter(Boolean);
  const pillars = pillarItems
    .map(
      (t, i) =>
        `<div class="flex items-center gap-4"><span class="font-display text-[15px] font-bold uppercase tracking-[0.02em] text-ink sm:text-[18px]">${esc(t)}</span>${i < pillarItems.length - 1 ? wheel(false, "hidden sm:block") : ""}</div>`,
    )
    .join("");

  const spans = tileSpans(tiles.length);
  const span = (k: number) =>
    ({ 2: "sm:col-span-2", 3: "sm:col-span-3", 4: "sm:col-span-4", 6: "sm:col-span-6" })[k] ??
    "sm:col-span-3";
  const bikes =
    tiles.length > 0
      ? `<section id="bikes" class="bg-bone py-24 sm:py-32"><div class="${WRAP} ">${rubric(num(), "Bike Worlds")}<div class="mb-14 max-w-2xl"><h2 class="font-display text-[38px] font-black uppercase leading-[0.92] text-ink sm:text-[52px]">${sie ? "Das richtige Rad.<br>Für jeden Weg." : "Dein richtiges Rad.<br>Für jeden Weg."}</h2></div><div class="grid grid-cols-1 gap-3 sm:grid-cols-6">${tiles
          .map(
            (t, i) =>
              `<div class="group relative min-h-[320px] overflow-hidden ${span(spans[i] ?? 3)}"><img alt="" class="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-105" src="${esc(t.img)}"><div class="absolute inset-0 bg-gradient-to-t from-ink/85 via-ink/10 to-transparent"></div><div class="relative flex h-full flex-col justify-end p-6"><h3 class="font-display text-[26px] font-black uppercase italic leading-none text-bone sm:text-[30px]">${esc(t.title)}</h3><p class="mt-2 max-w-[220px] text-[13px] leading-snug text-bone/75">${esc(t.text)}</p></div></div>`,
          )
          .join("")}</div></div></section>`
      : "";

  const statement = `<section class="relative overflow-hidden bg-ink py-28 sm:py-36"><div class="${WRAP} relative"><div class="max-w-4xl"><p class="font-display text-[13vw] font-black uppercase leading-[0.9] text-bone sm:text-[6.4vw]  ">Jeden Trail.</p><p class="font-display text-[13vw] font-black uppercase leading-[0.9] text-bone sm:text-[6.4vw] pl-[6%] italic text-magenta-bright sm:pl-[10%] ">Jede Straße.</p><p class="font-display text-[13vw] font-black uppercase leading-[0.9] text-bone sm:text-[6.4vw]  pl-[3%] sm:pl-[5%]">Jeden Kilometer.</p></div></div></section>`;

  const step = (no: string, title: string, text: string) =>
    `<div class="flex items-start gap-6 border-t border-ink/12 py-6 first:border-t-0 last:border-b"><span class="font-display text-[13px] font-bold tracking-[0.1em] text-magenta">${no}</span><div><h3 class="mb-1 font-display text-[17px] font-bold uppercase tracking-tight text-ink">${esc(title)}</h3><p class="text-[13.5px] leading-relaxed text-graphite">${esc(text)}</p></div></div>`;
  const partners = c.leasing?.partners ?? [];
  const leasingSection = leasing
    ? `<section id="leasing" class="bg-bone-dim py-24 sm:py-32"><div class="${WRAP} ">${rubric(num(), "Dienstrad-Leasing")}<div class="grid grid-cols-1 gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10"><div><h2 class="mb-7 font-display text-[40px] font-black uppercase leading-[0.9] text-ink sm:text-[58px] lg:text-[4.4vw]">${sie ? "Ihr Traumbike." : "Dein Traumbike."}<br><span class="italic text-magenta">Per Arbeitgeber-Leasing.</span></h2><p class="mb-11 max-w-[440px] text-[15px] leading-relaxed text-graphite">${sie ? "Sie möchten Ihr Rad über Ihren Arbeitgeber finanzieren? Wir begleiten Sie persönlich von der Auswahl bis zur Übergabe." : "Du möchtest dein Rad über deinen Arbeitgeber finanzieren? Wir begleiten dich persönlich von der Auswahl bis zur Übergabe."}</p><a class="${BTN} rounded-tight px-6 py-3 bg-ink text-bone hover:bg-magenta-deep " href="${tel}">Leasing-Beratung</a></div><div class="flex flex-col gap-0">${step("01", "Bike aussuchen", "Gemeinsam finden wir das passende Modell.")}${step("02", "Leasing nutzen", sie ? "Über Ihren Arbeitgeber und einen Leasing-Partner." : "Über deinen Arbeitgeber und einen Leasing-Partner.")}${step("03", "Losfahren", "Abholung, Einweisung und Übergabe direkt im Laden.")}</div></div></div>${
        partners.length > 0
          ? `<div class="mt-16 sm:mt-20"><div class="${WRAP} "><p class="mb-6 font-display text-[11px] font-bold uppercase tracking-[0.24em] text-graphite">Unsere Leasing-Partner</p></div><div class="flex flex-col gap-3 overflow-hidden bg-ink py-9 sm:gap-4 sm:py-11"><div class="overflow-hidden"><div class="flex w-max items-center animate-marquee-left">${[
              ...partners,
              ...partners,
              ...partners,
            ]
              .map(
                (x) =>
                  `<div class="flex shrink-0 items-center gap-8 pr-8"><span class="font-display text-[32px] font-black uppercase italic leading-none text-bone sm:text-[44px]">${esc(x)}</span>${wheel(true)}</div>`,
              )
              .join("")}</div></div></div></div>`
          : ""
      }</section>`
    : "";

  const serviceImage = c.about.image ?? gallery.shift() ?? null;
  const service =
    c.services.length > 0
      ? `<section id="service" class="bg-bone py-24 sm:py-32"><div class="${WRAP} ">${rubric(num(), "Werkstatt & Service")}<div class="grid grid-cols-1 gap-14 lg:grid-cols-2 lg:gap-16"><div><h2 class="mb-10 font-display text-[38px] font-black uppercase leading-[0.9] text-ink sm:text-[52px]">${sie ? "Ihr Bike." : "Dein Bike."}<br><span class="italic text-magenta">Unser Handwerk.</span></h2><ul class="mb-10 flex flex-col">${c.services
          .slice(0, 5)
          .map(
            (s) =>
              `<li class="flex items-start gap-5 border-t border-ink/12 py-5 first:border-t-0"><span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-magenta" aria-hidden="true"></span><div><h3 class="mb-1 font-display text-[16px] font-bold uppercase tracking-tight text-ink">${esc(s.title)}</h3><p class="text-[13.5px] leading-relaxed text-graphite">${esc(s.text)}</p></div></li>`,
          )
          .join(
            "",
          )}</ul></div><div class="relative min-h-[340px] overflow-hidden bg-ink lg:min-h-0">${serviceImage ? `<img alt="" class="absolute inset-0 h-full w-full object-cover" src="${esc(serviceImage)}">` : ""}<div class="absolute inset-0 bg-gradient-to-t from-ink via-ink/40 to-ink/10"></div><div class="relative flex h-full flex-col justify-end p-8"><span class="mb-2 font-display text-[11px] font-bold uppercase tracking-[0.24em] text-magenta-bright">Werkstatt</span><p class="max-w-[280px] font-display text-[22px] font-black uppercase italic leading-tight text-bone">${esc(c.handwriting ?? "Handwerk, das man sieht und merkt.")}</p></div></div></div></div></section>`
      : "";

  const brands = c.brands ?? [];
  const marken =
    brands.length >= 3
      ? `<section id="marken" class="bg-bone-dim py-24 sm:py-28"><div class="${WRAP} ">${rubric(num(), "Unsere Marken")}<div class="mb-12 flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><h2 class="font-display text-[32px] font-black uppercase leading-[0.92] text-ink sm:text-[42px]">Echte Auswahl,<br>vertraute Marken.</h2><p class="max-w-[280px] text-[13px] leading-relaxed text-graphite">Hersteller, denen wir vertrauen und deren Räder wirklich bei uns stehen.</p></div><div class="flex flex-wrap border-t border-ink/15">${brands
          .slice(0, 6)
          .map(
            (b) =>
              `<div class="flex min-h-[104px] flex-1 basis-1/2 items-center border-b border-r border-ink/15 px-6 py-6 last:border-r-0 sm:basis-1/3 lg:basis-1/6"><span class="font-display text-[20px] font-black italic uppercase leading-tight tracking-tight text-ink sm:text-[22px]">${esc(b)}</span></div>`,
          )
          .join("")}</div></div></section>`
      : "";

  const quotes = c.reviews.quotes.slice(0, 3);
  const reviews =
    c.reviews.rating && c.reviews.count && quotes.length > 0
      ? `<section class="bg-bone py-24 sm:py-28"><div class="${WRAP} ">${rubric(num(), "Kundenstimmen")}<div class="mb-12 flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><h2 class="font-display text-[32px] font-black uppercase leading-[0.92] text-ink sm:text-[42px]">${c.reviews.rating.toFixed(1).replace(".", ",")} Sterne.<br><span class="italic text-magenta">${c.reviews.count} Bewertungen.</span></h2><p class="max-w-[280px] text-[13px] leading-relaxed text-graphite">So bewerten uns Kundinnen und Kunden bei Google.</p></div><ul class="mb-10 flex flex-col">${quotes
          .map(
            (q) =>
              `<li class="flex items-start gap-5 border-t border-ink/12 py-5 first:border-t-0"><span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-magenta" aria-hidden="true"></span><div><h3 class="mb-1 font-display text-[16px] font-bold uppercase tracking-tight text-ink">${esc(q.author)}</h3><p class="text-[13.5px] leading-relaxed text-graphite">„${esc(q.text)}“</p></div></li>`,
          )
          .join("")}</ul></div></section>`
      : "";

  const hours = c.contact.hours
    .map((h) => {
      const i = h.indexOf(":");
      return i > 0 ? [h.slice(0, i), h.slice(i + 1).trim()] : [h, ""];
    })
    .map(
      ([d, v]) =>
        `<div class="flex items-baseline justify-between border-b border-bone/12 py-3"><dt class="font-display text-[13px] font-bold uppercase tracking-[0.04em] text-bone">${esc(d!)}</dt><dd class="text-[13px] text-graphite-soft">${esc(v!)}</dd></div>`,
    )
    .join("");
  const kontakt = `<section id="kontakt" class="bg-ink py-24 sm:py-32"><div class="${WRAP} ">${rubric(num(), "Kontakt", true)}<div class="grid grid-cols-1 gap-14 lg:grid-cols-[1.1fr_0.9fr] lg:gap-20"><div><h2 class="mb-8 font-display text-[38px] font-black uppercase leading-[0.9] text-bone sm:text-[54px]">Vorbeikommen.<br><span class="italic text-magenta-bright">Probefahren.</span></h2><p class="mb-10 max-w-[400px] text-[15px] leading-relaxed text-graphite-soft">${esc(c.contact.address ?? "")}</p><div class="flex flex-wrap items-center gap-5">${c.contact.mapsUrl ? `<a class="${BTN} rounded-tight px-6 py-3 bg-bone text-ink hover:bg-magenta-bright hover:text-ink " href="${esc(c.contact.mapsUrl)}" target="_blank" rel="noopener noreferrer">Route planen</a>` : ""}${phone ? `<a class="${BTN} rounded-tight px-6 py-3 border border-bone/40 text-bone hover:border-magenta-bright hover:text-magenta-bright " href="${tel}">Jetzt anrufen</a>` : ""}${c.contact.email ? `<a class="${BTN} py-2 text-bone underline decoration-bone/30 underline-offset-4 hover:decoration-magenta-bright hover:text-magenta-bright " href="mailto:${esc(c.contact.email)}">E-Mail schreiben</a>` : ""}</div></div>${hours ? `<div><p class="mb-5 font-display text-[11px] font-bold tracking-[0.24em] text-graphite-soft">Öffnungszeiten</p><dl class="border-t border-bone/12">${hours}</dl></div>` : ""}</div></div></section>`;

  const navLinks = [
    tiles.length > 0 ? ["#bikes", "Bikes"] : null,
    leasing ? ["#leasing", "Leasing"] : null,
    c.services.length > 0 ? ["#service", "Service"] : null,
    brands.length >= 3 ? ["#marken", "Marken"] : null,
    ["#kontakt", "Kontakt"],
  ].filter((x): x is string[] => x !== null);
  const nav = navLinks
    .map(
      ([h, l]) =>
        `<a href="${h}" class="font-display text-[13px] font-bold uppercase tracking-[0.1em] text-ink transition-colors hover:text-magenta">${l}</a>`,
    )
    .join("");
  const footerNav = navLinks
    .map(
      ([h, l]) =>
        `<li><a href="${h}" class="text-[13.5px] text-bone/85 transition-colors hover:text-magenta-bright">${l}</a></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(c.name)} · Entwurf</title>
<link rel="stylesheet" href="style.css">
<style>:root { --color-magenta: ${accent}; --color-magenta-bright: ${bright}; --color-magenta-deep: ${p.deep}; }</style>
</head>
<body>
<div id="root">
<div class="relative z-50 flex items-center justify-center gap-3 bg-ink px-4 py-2.5 text-center"><span class="font-display text-[11px] font-bold tracking-[0.14em] text-bone sm:text-[12px]">Entwurf: So könnte ${sie ? "Ihre" : "eure"} neue Website aussehen.</span><span class="hidden text-[11px] text-graphite-soft sm:inline">Erstellt von Christian Dobler, nicht öffentlich.</span></div>
<header class="sticky top-0 z-40 transition-colors duration-300 bg-bone/90 backdrop-blur-md shadow-[0_1px_0_0_rgba(20,19,17,0.08)]"><div class="${WRAP} "><div class="flex h-20 items-center justify-between"><a href="#top" class="shrink-0" aria-label="${esc(c.name)}"><span class="inline-flex items-center gap-2 ">${wordmark(false)}</span></a><nav class="hidden items-center gap-9 lg:flex" aria-label="Hauptnavigation">${nav}</nav><div class="hidden items-center gap-6 lg:flex">${phone ? `<a href="${tel}" class="font-display text-[13px] font-bold uppercase tracking-[0.08em] text-ink transition-colors hover:text-magenta">${esc(phone)}</a>` : ""}<a href="${leasing ? "#leasing" : tel}" class="inline-flex min-h-11 items-center rounded-tight bg-ink px-5 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.08em] text-bone transition-colors hover:bg-magenta-deep">${esc(leasing ? "Leasing entdecken" : c.cta)}</a></div></div></div></header>
<main id="main-content">
<section id="top" class="relative overflow-hidden bg-ink"><div class="relative min-h-[100svh] lg:grid lg:min-h-[92svh] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]"><div class="absolute inset-0 lg:hidden"><img alt="" class="h-full w-full object-cover" src="${esc(heroImage)}"><div class="absolute inset-0 bg-gradient-to-t from-ink via-ink/85 to-ink/50"></div></div><div class="relative z-10 flex min-h-[100svh] flex-col justify-center px-6 pb-16 pt-24 sm:px-10 lg:min-h-0 lg:px-14 lg:pt-28 lg:pb-24"><p class="mb-7 flex items-center gap-2.5 font-display text-[11px] font-bold uppercase tracking-[0.28em] text-graphite-soft"><span class="h-1.5 w-1.5 rounded-full bg-magenta-bright" aria-hidden="true"></span>${esc(c.claim)}</p><h1 class="mb-8 font-display font-black uppercase leading-[0.88] text-bone">${h1}</h1><p class="mb-10 max-w-[380px] text-[15px] leading-relaxed text-graphite-soft">${esc(c.hero.text)}</p><div class="flex flex-wrap items-center gap-5"><a class="${BTN} rounded-tight px-6 py-3 bg-bone text-ink hover:bg-magenta-bright hover:text-ink " href="${tiles.length > 0 ? "#bikes" : tel}">${tiles.length > 0 ? "Bikes entdecken" : esc(c.cta)}</a><a class="${BTN} rounded-tight px-6 py-3 border border-bone/40 text-bone hover:border-magenta-bright hover:text-magenta-bright " href="${leasing ? "#leasing" : "#kontakt"}">${leasing ? "Leasing entdecken" : "Laden besuchen"}</a></div></div><div class="relative hidden lg:block lg:min-h-0"><div class="absolute inset-0" style="clip-path: polygon(9% 0px, 100% 0px, 100% 100%, 0px 100%);"><img alt="" class="h-full w-full object-cover" src="${esc(heroImage)}"><div class="absolute inset-0 bg-gradient-to-t from-ink/70 via-ink/10 to-ink/50"></div><div class="absolute inset-0 bg-ink/15"></div></div></div></div><div class="${WRAP} relative z-10 hidden items-center justify-between border-t border-bone/10 py-5 lg:flex"><span class="font-display text-[11px] font-bold uppercase tracking-[0.24em] text-graphite-soft">${esc(strip)}</span><span class="font-display text-[11px] font-bold uppercase tracking-[0.24em] text-graphite-soft">${esc([street, city].filter(Boolean).join(" · "))}</span></div></section>
<section class="border-b border-ink/10 bg-bone py-9 sm:py-11"><div class="${WRAP} "><div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-4 sm:justify-between">${pillars}</div></div></section>
${bikes}
${statement}
${leasingSection}
${service}
${marken}
${reviews}
${kontakt}
</main>
<footer class="bg-ink pt-20"><div class="${WRAP} "><div class="mb-16 grid grid-cols-1 gap-12 border-b border-bone/12 pb-16 sm:grid-cols-2 lg:grid-cols-4"><div><span class="inline-flex items-center gap-2 mb-5">${wordmark(true)}</span><p class="max-w-[220px] text-[13px] leading-relaxed text-graphite-soft">${esc(c.hero.text)}</p></div><div><p class="mb-4 font-display text-[11px] font-bold uppercase tracking-[0.2em] text-graphite-soft">Navigation</p><ul class="flex flex-col gap-2.5">${footerNav}</ul></div><div><p class="mb-4 font-display text-[11px] font-bold uppercase tracking-[0.2em] text-graphite-soft">Kontakt</p><ul class="flex flex-col gap-2.5 text-[13.5px] text-bone/85">${c.contact.address ? `<li>${esc(c.contact.address)}</li>` : ""}${phone ? `<li><a href="${tel}" class="transition-colors hover:text-magenta-bright">${esc(phone)}</a></li>` : ""}${c.contact.email ? `<li><a href="mailto:${esc(c.contact.email)}" class="transition-colors hover:text-magenta-bright break-all">${esc(c.contact.email)}</a></li>` : ""}</ul></div><div></div></div><div class="mb-10 select-none font-display text-[13vw] font-black uppercase italic leading-none tracking-tight text-bone/[0.04] sm:text-[9vw]">${esc(c.name.toUpperCase())}</div><div class="flex flex-col items-start justify-between gap-4 border-t border-bone/12 py-6 sm:flex-row sm:items-center"><span class="font-display text-[10px] font-bold uppercase tracking-[0.2em] text-graphite-soft">© ${esc(c.name)} · Entwurf von Avelio</span><span class="font-display text-[10px] font-bold uppercase tracking-[0.2em] text-graphite-soft">Impressum und Datenschutz folgen</span></div></div></footer>
</div>
</body>
</html>`;
}
