import { paletteFrom } from "../color.js";
import { icon, type SiteContent } from "../content.js";

/**
 * Vorlage Handwerk, Fahrrad, Kfz ("werkstatt"): robust und klar statt weich. Zweigeteilter Hero (dunkle Fläche mit
 * Name, Foto mit schräger Kante), Vertrauens-Band in Markenfarbe, Leistungen mit Werkzeug-Icons, große Galerie
 * "Unsere Arbeit", Ablauf als Zeitleiste, Bewertungen, Kontakt. Übergänge als gerade, schräge Schnitte.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "").replace(/^00/, "+")}`;

/** Letztes Wort hervorheben (Vorbild fs-pbg: „DEIN NEUES BIKE BEGINNT *HIER.*“). */
export function accentLast(text: string): string {
  const m = /^(.*\s)(\S+)$/.exec(text.trim());
  return m ? `${esc(m[1]!)}<em>${esc(m[2]!)}</em>` : esc(text);
}

/** Nummerierte Rubrik mit kurzer Linie (Vorbild HIWO-med: „02 — Warum …“). */
const eyebrow = (n: number, label: string) =>
  `<div class="eyebrow"><span class="n">${String(n).padStart(2, "0")}</span><span class="ln"></span>${label}</div>`;

export function renderWerkstatt(c: SiteContent): string {
  const p = paletteFrom(c.primary);
  const sie = c.form === "sie";
  const phone = c.contact.phone;
  const ctaHref = phone ? telHref(phone) : "#kontakt";
  const rating =
    c.reviews.rating && c.reviews.count && c.reviews.rating >= 4.3
      ? `<div class="rating"><span class="s">★★★★★</span><b>${c.reviews.rating.toFixed(1).replace(".", ",")}</b> · ${c.reviews.count} Google-Bewertungen</div>`
      : "";

  const services = c.services
    .map(
      (s, i) => `<article class="svc">
  <div class="ic">${icon(s.icon)}</div>
  <div><div class="no">${String(i + 1).padStart(2, "0")}</div><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>
</article>`,
    )
    .join("\n");

  const steps = c.steps
    .map((s, i) => `<li><span class="num">${i + 1}</span><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`)
    .join("\n");

  const gallery =
    c.gallery.length >= 2
      ? `<section class="work" id="arbeit"><div class="wrap">
  <div class="head">${eyebrow(2, "Unsere Arbeit")}<h2>Ein Blick in unsere Arbeit</h2></div>
  <div class="grid g${Math.min(c.gallery.length, 5)}">${c.gallery
    .slice(0, 5)
    .map((g, i) => `<img src="${esc(g)}" alt="Arbeit ${i + 1}">`)
    .join("")}</div>
</div></section>`
      : "";

  const quotes = c.reviews.quotes
    .slice(0, 3)
    .map(
      (q) =>
        `<figure class="quote"><div class="qs">★★★★★</div><blockquote>„${esc(q.text)}“</blockquote><figcaption>${esc(q.author)}</figcaption></figure>`,
    )
    .join("\n");
  const reviews =
    c.reviews.rating && c.reviews.count
      ? `<section class="reviews"><div class="wrap">
  <div class="score"><div class="big">${c.reviews.rating.toFixed(1).replace(".", ",")}</div><div><div class="stars">★★★★★</div><div class="muted">${c.reviews.count} Bewertungen bei Google</div></div></div>
  ${quotes ? `<div class="quotes">${quotes}</div>` : ""}
</div></section>`
      : "";

  // Faktenleiste unter dem Hero (Vorbild HIWO-med): nur was belegt ist.
  const factCells = [
    c.reviews.rating && c.reviews.count
      ? [
          "Bewertung",
          `${c.reviews.rating.toFixed(1).replace(".", ",")} ★ · ${c.reviews.count} Google-Bewertungen`,
        ]
      : null,
    c.contact.hours[0] ? ["Geöffnet", c.contact.hours.slice(0, 2).join(" · ")] : null,
    c.contact.address ? ["Standort", c.contact.address] : null,
    phone ? ["Telefon", phone] : null,
  ].filter((x): x is string[] => x !== null);
  const facts =
    factCells.length > 0
      ? `<section class="facts"><div class="wrap">${factCells
          .map(([k, v]) => `<div><div class="k">${esc(k!)}</div><div class="v">${esc(v!)}</div></div>`)
          .join("")}</div></section>`
      : "";
  const trustList =
    c.trust.length > 0
      ? `<ul class="trust">${c.trust.map((t) => `<li>${icon("check")}${esc(t)}</li>`).join("")}</ul>`
      : "";

  const brand = c.logo
    ? `<img class="logo" src="${esc(c.logo)}" alt="${esc(c.name)}">`
    : `<span class="wordmark">${esc(c.name)}</span>`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(c.name)} · Entwurf</title>
<style>
@font-face { font-family: Manrope; src: url(fonts/manrope-400.woff2) format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: Manrope; src: url(fonts/manrope-600.woff2) format("woff2"); font-weight: 600; font-display: swap; }
@font-face { font-family: Manrope; src: url(fonts/manrope-800.woff2) format("woff2"); font-weight: 800; font-display: swap; }
:root { --primary: ${p.primary}; --deep: ${p.deep}; --tint: ${p.tint}; --soft: ${p.soft}; --ink: #15181c; --paper: #f6f5f2; --muted: #5d636b; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: Manrope, system-ui, sans-serif; color: var(--ink); background: var(--paper); font-size: 17px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
img { max-width: 100%; display: block; }
a { color: inherit; }
.wrap { width: min(1200px, calc(100% - 40px)); margin: 0 auto; }
.note { background: #000; color: #fff; font-size: 13px; text-align: center; padding: 7px 12px; }
.note b { color: ${p.soft}; }
header.top { position: sticky; top: 0; z-index: 20; background: var(--ink); color: #fff; }
header.top .wrap { display: flex; align-items: center; justify-content: space-between; gap: 24px; height: 74px; }
.logo { max-height: 46px; width: auto; background: #fff; padding: 4px 8px; border-radius: 6px; }
.wordmark { font-weight: 800; font-size: 20px; letter-spacing: -.01em; }
nav.menu { display: flex; gap: 28px; font-weight: 600; font-size: 15px; }
nav.menu a { text-decoration: none; opacity: .75; }
nav.menu a:hover { opacity: 1; }
.btn { display: inline-flex; align-items: center; gap: 10px; background: var(--primary); color: #fff; text-decoration: none; font-weight: 800; padding: 15px 26px; border-radius: 6px; letter-spacing: .01em; white-space: nowrap; transition: background .2s, transform .2s; }
.btn:hover { background: var(--deep); transform: translateY(-1px); }
.btn svg { width: 18px; height: 18px; stroke-width: 2.4; }
.btn.small { padding: 10px 18px; font-size: 15px; }
.hero { display: grid; grid-template-columns: 1.05fr 1fr; min-height: calc(100vh - 108px); max-height: 820px; background: var(--ink); color: #fff; }
.hero .text { position: relative; padding: 80px 56px 80px max(20px, calc((100vw - 1200px) / 2)); display: flex; flex-direction: column; justify-content: center;
  background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 2px, transparent 2px 14px); }
.claim { display: inline-flex; align-self: flex-start; align-items: center; gap: 10px; text-transform: uppercase; letter-spacing: .18em; font-weight: 800; font-size: 13px; color: var(--ink); background: ${p.soft}; padding: 8px 14px; border-radius: 4px; }
.claim svg { width: 18px; height: 18px; stroke-width: 2.4; }
.hero h1 { font-size: clamp(44px, 6vw, 86px); line-height: .98; letter-spacing: -.035em; margin: 22px 0 14px; font-weight: 800; }
.hero .benefit { font-size: clamp(21px, 2.1vw, 30px); font-weight: 700; line-height: 1.2; color: ${p.soft}; margin: 0 0 12px; max-width: 24ch; }
.hero p.lead { font-size: 18px; opacity: .85; max-width: 46ch; margin: 0 0 30px; }
.hero .actions { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.rating { font-size: 15px; } .rating .s { color: #f6c445; letter-spacing: 2px; margin-right: 8px; }
.hero .photo { position: relative; background: ${c.hero.image ? `url('${esc(c.hero.image)}') center/cover` : `linear-gradient(135deg, ${p.primary}, ${p.deep})`};
  clip-path: polygon(14% 0, 100% 0, 100% 100%, 0 100%); }
.hero .nophoto { display: grid; place-items: center; background: radial-gradient(circle at 70% 30%, ${p.primary}, ${p.deep} 70%);
  background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.06) 0 2px, transparent 2px 18px), radial-gradient(circle at 70% 30%, ${p.primary}, ${p.deep} 75%); }
.nophoto .mark { color: rgba(255,255,255,.18); } .nophoto .mark svg { width: min(46vw, 420px); height: min(46vw, 420px); stroke-width: 1.1; }
.nophoto .stamp { position: absolute; right: 9%; bottom: 12%; background: #fff; color: var(--ink); border-radius: 50%; width: 170px; height: 170px;
  display: grid; place-content: center; text-align: center; transform: rotate(-8deg); box-shadow: 0 20px 40px rgba(0,0,0,.35); }
.stamp b { font-size: 46px; line-height: 1; color: var(--primary); } .stamp span { color: #f2b01e; letter-spacing: 2px; } .stamp small { font-size: 12px; font-weight: 700; padding: 0 18px; line-height: 1.2; }
section { position: relative; }
.eyebrow .n { margin-right: 10px; } .eyebrow .ln { display: inline-block; width: 34px; height: 2px; background: currentColor; vertical-align: middle; margin-right: 12px; opacity: .7; }
.hero .benefit em { font-style: italic; color: #fff; }
.facts { background: #fff; border-bottom: 1px solid rgba(0,0,0,.08); }
.facts .wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.facts .wrap > div { padding: 22px 24px 22px 0; border-right: 1px solid rgba(0,0,0,.08); margin-right: 24px; }
.facts .wrap > div:last-child { border-right: 0; }
.facts .k { text-transform: uppercase; letter-spacing: .16em; font-size: 12px; font-weight: 800; color: var(--primary); }
.facts .v { font-size: 15px; font-weight: 600; margin-top: 4px; }
ul.trust { list-style: none; margin: -12px 0 28px; padding: 0; display: flex; flex-wrap: wrap; gap: 10px 26px; font-weight: 700; }
ul.trust li { display: flex; align-items: center; gap: 8px; } ul.trust svg { width: 20px; height: 20px; color: var(--primary); stroke-width: 2.6; }
.eyebrow { text-transform: uppercase; letter-spacing: .2em; font-size: 13px; font-weight: 800; color: var(--primary); }
h2 { font-size: clamp(30px, 3.4vw, 46px); line-height: 1.08; letter-spacing: -.025em; margin: 10px 0 30px; font-weight: 800; }
.services { padding: 70px 0 80px; }
.svcs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
.svc { display: grid; grid-template-columns: 64px 1fr; gap: 18px; background: #fff; border: 1px solid rgba(0,0,0,.07); border-left: 5px solid var(--primary); padding: 24px; border-radius: 6px; }
.svc .ic { width: 64px; height: 64px; display: grid; place-items: center; background: var(--ink); color: #fff; border-radius: 6px; }
.svc .ic svg { width: 32px; height: 32px; stroke-width: 1.9; }
.svc .no { font-size: 13px; font-weight: 800; color: var(--primary); letter-spacing: .1em; }
.svc h3 { margin: 2px 0 6px; font-size: 20px; } .svc p { margin: 0; color: var(--muted); font-size: 16px; }
.work { padding: 60px 0 80px; background: var(--ink); color: #fff; clip-path: polygon(0 4%, 100% 0, 100% 96%, 0 100%); }
.work .eyebrow { color: ${p.soft}; }
.work .grid { display: grid; gap: 12px; grid-template-columns: repeat(3, 1fr); grid-auto-rows: 240px; }
.work .grid img { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; }
.work .g3 img:first-child, .work .g5 img:first-child { grid-row: span 2; }
.work .g2 { grid-template-columns: 1fr 1fr; grid-auto-rows: 340px; }
.work .g4 { grid-template-columns: repeat(4, 1fr); }
.about { padding: 90px 0; }
.about .wrap { display: grid; grid-template-columns: 1fr 1.1fr; gap: 64px; align-items: center; }
.about .photo img, .about .ph { width: 100%; aspect-ratio: 4/3.2; object-fit: cover; border-radius: 6px; box-shadow: 18px 18px 0 var(--primary); }
.about .ph { background: linear-gradient(135deg, var(--primary), var(--deep)); display: grid; place-items: center; color: #fff; font-size: 96px; font-weight: 800; }
.about p { color: var(--muted); white-space: pre-line; }
.steps { padding: 30px 0 90px; }
.steps ol { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; position: relative; }
.steps ol::before { content: ""; position: absolute; top: 27px; left: 8%; right: 8%; height: 3px; background: var(--soft); }
.steps li { position: relative; }
.steps .num { position: relative; display: inline-grid; place-items: center; width: 56px; height: 56px; border-radius: 6px; background: var(--primary); color: #fff; font-weight: 800; font-size: 22px; margin-bottom: 14px; }
.steps h3 { margin: 0 0 6px; font-size: 20px; } .steps p { margin: 0; color: var(--muted); }
.reviews { padding: 70px 0; background: #fff; }
.score { display: flex; align-items: center; gap: 22px; margin-bottom: 30px; }
.score .big { font-size: 76px; font-weight: 800; line-height: 1; color: var(--primary); letter-spacing: -.03em; }
.stars, .qs { color: #f2b01e; letter-spacing: 3px; font-size: 24px; } .qs { font-size: 17px; }
.muted { color: var(--muted); }
.quotes { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
.quote { margin: 0; padding: 24px; border: 1px solid rgba(0,0,0,.08); border-top: 4px solid var(--primary); border-radius: 6px; background: var(--paper); }
.quote blockquote { margin: 10px 0 12px; } .quote figcaption { font-weight: 800; font-size: 15px; }
.contact { background: var(--ink); color: #fff; padding: 90px 0 70px; clip-path: polygon(0 6%, 100% 0, 100% 100%, 0 100%); }
.contact .wrap { display: grid; grid-template-columns: 1.1fr 1fr; gap: 60px; }
.contact h2 { color: #fff; } .contact .eyebrow { color: ${p.soft}; }
.contact dl { margin: 0; display: grid; gap: 18px; }
.contact dt { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: .14em; color: ${p.soft}; }
.contact dt svg { width: 18px; height: 18px; } .contact dd { margin: 4px 0 0 28px; font-size: 18px; } .contact dd a { text-decoration: none; }
.callcard { background: var(--primary); border-radius: 6px; padding: 36px; }
.callcard h3 { font-size: 28px; margin: 0 0 10px; } .callcard p { margin: 0 0 20px; opacity: .9; }
.callcard .tel { display: block; font-size: 32px; font-weight: 800; text-decoration: none; margin-bottom: 18px; }
.callcard .btn { background: var(--ink); } .callcard .btn:hover { background: #000; }
footer { background: #000; color: rgba(255,255,255,.55); font-size: 14px; padding: 24px 0; }
footer .wrap { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.mobilecall { display: none; }
@media (max-width: 900px) {
  nav.menu, header.top .btn { display: none; }
  .hero { grid-template-columns: 1fr; max-height: none; min-height: 0; }
  .hero .photo { order: -1; height: 260px; clip-path: polygon(0 0, 100% 0, 100% 86%, 0 100%); }
  .nophoto .stamp { width: 120px; height: 120px; } .stamp b { font-size: 32px; } .nophoto .mark svg { width: 200px; height: 200px; }
  .hero .text { padding: 40px 20px 60px; }
  .svcs { grid-template-columns: 1fr; }
  .facts .wrap > div { border-right: 0; border-bottom: 1px solid rgba(0,0,0,.08); padding: 14px 0; margin: 0; }
  .svc { grid-template-columns: 48px 1fr; padding: 18px; } .svc .ic { width: 48px; height: 48px; } .svc .ic svg { width: 26px; height: 26px; }
  .work .grid, .work .g4 { grid-template-columns: 1fr 1fr; grid-auto-rows: 160px; }
  .about .wrap, .contact .wrap { grid-template-columns: 1fr; gap: 36px; }
  .steps ol { grid-template-columns: 1fr; } .steps ol::before { display: none; }
  .mobilecall { display: flex; position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 30; justify-content: center; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
  body { padding-bottom: 80px; }
}
</style>
</head>
<body>
<div class="note">Entwurf: <b>So könnte ${sie ? "Ihre" : "eure"} neue Website aussehen.</b> Erstellt von Christian Dobler, nicht öffentlich.</div>
<header class="top"><div class="wrap">
  <a href="#" aria-label="Start">${brand}</a>
  <nav class="menu"><a href="#leistungen">Leistungen</a>${c.gallery.length >= 2 ? '<a href="#arbeit">Unsere Arbeit</a>' : ""}<a href="#ueber-uns">Über uns</a><a href="#kontakt">Kontakt</a></nav>
  <a class="btn small" href="${ctaHref}">${icon("phone")}${esc(c.cta)}</a>
</div></header>

<section class="hero">
  <div class="text">
    <div class="claim">${icon(c.services[0]?.icon ?? "wrench")}${esc(c.claim)}</div>
    <h1>${esc(c.name)}</h1>
    <p class="benefit">${accentLast(c.hero.headline)}</p>
    <p class="lead">${esc(c.hero.text)}</p>
    <div class="actions"><a class="btn" href="${ctaHref}">${icon("phone")}${esc(c.cta)}</a>${rating}</div>
  </div>
  ${
    c.hero.image
      ? `<div class="photo" role="img" aria-label="${esc(c.name)}"></div>`
      : `<div class="photo nophoto"><div class="mark">${icon(c.services[0]?.icon ?? "wrench")}</div>${
          c.reviews.rating && c.reviews.count
            ? `<div class="stamp"><b>${c.reviews.rating.toFixed(1).replace(".", ",")}</b><span>★★★★★</span><small>${c.reviews.count} Google-Bewertungen</small></div>`
            : ""
        }</div>`
  }
</section>

${facts}

<section class="services" id="leistungen"><div class="wrap">
  ${eyebrow(1, "Leistungen")}<h2>${sie ? "Was wir für Sie machen" : "Was wir für dich machen"}</h2>
  ${trustList}
  <div class="svcs">${services}</div>
</div></section>

${gallery}

<section class="about" id="ueber-uns"><div class="wrap">
  <div class="photo">${c.about.image ? `<img src="${esc(c.about.image)}" alt="${esc(c.name)}">` : `<div class="ph">${esc(c.name.slice(0, 1))}</div>`}</div>
  <div>${eyebrow(c.gallery.length >= 2 ? 3 : 2, "Über uns")}<h2>${esc(c.about.title)}</h2><p>${esc(c.about.text)}</p></div>
</div></section>

<section class="steps" id="ablauf"><div class="wrap">
  ${eyebrow(c.gallery.length >= 2 ? 4 : 3, "So läuft's")}<h2>${sie ? "In drei Schritten zu Ihrem Auftrag" : "In drei Schritten zu deinem Auftrag"}</h2>
  <ol>${steps}</ol>
</div></section>

${reviews}

<section class="contact" id="kontakt"><div class="wrap">
  <div>
    ${eyebrow(c.gallery.length >= 2 ? 5 : 4, "Kontakt")}<h2>${sie ? "Wir freuen uns auf Ihre Anfrage." : "Wir freuen uns auf deine Anfrage."}</h2>
    <dl>
      ${c.contact.address ? `<div><dt>${icon("map-pin")}Adresse</dt><dd>${c.contact.mapsUrl ? `<a href="${esc(c.contact.mapsUrl)}" target="_blank" rel="noopener">${esc(c.contact.address)}</a>` : esc(c.contact.address)}</dd></div>` : ""}
      ${phone ? `<div><dt>${icon("phone")}Telefon</dt><dd><a href="${telHref(phone)}">${esc(phone)}</a></dd></div>` : ""}
      ${c.contact.email ? `<div><dt>${icon("mail")}E-Mail</dt><dd><a href="mailto:${esc(c.contact.email)}">${esc(c.contact.email)}</a></dd></div>` : ""}
      ${c.contact.hours.length > 0 ? `<div><dt>${icon("clock")}Öffnungszeiten</dt><dd>${c.contact.hours.map(esc).join("<br>")}</dd></div>` : ""}
    </dl>
  </div>
  <div class="callcard">
    <h3>${sie ? "Rufen Sie uns an" : "Ruf uns an"}</h3>
    <p>${sie ? "Kurz schildern, was ansteht, wir melden uns mit einem Termin für die Besichtigung." : "Kurz schildern, was ansteht, wir melden uns mit einem Termin."}</p>
    ${phone ? `<a class="tel" href="${telHref(phone)}">${esc(phone)}</a>` : ""}
    <a class="btn" href="${ctaHref}">${icon("phone")}${esc(c.cta)}</a>
  </div>
</div></section>
<footer><div class="wrap"><span>© ${esc(c.name)}</span><span>Entwurf von Avelio · Impressum und Datenschutz folgen</span></div></footer>
${phone ? `<a class="btn mobilecall" href="${telHref(phone)}">${icon("phone")}${esc(c.cta)}</a>` : ""}
</body>
</html>`;
}
