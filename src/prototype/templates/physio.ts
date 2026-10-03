import { paletteFrom } from "../color.js";
import { icon, type SiteContent } from "../content.js";
import { curveSvg, edgeSvg, wavesSvg } from "../transitions.js";

/**
 * Vorlage Physiotherapie (Vorbild MEDIANA, config/inspiration.yaml): großes Foto im Hero mit Claim in Versalien,
 * drei gestaffelte Bergkämme als Übergang, Leistungen als Kacheln, Ablauf auf Markenfarbe mit Risskanten,
 * Bewertungen, Galerie, Kontakt. Eine Datei, kein JavaScript-Framework, Schriften lokal.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "").replace(/^00/, "+")}`;

export function renderPhysio(c: SiteContent): string {
  const p = paletteFrom(c.primary);
  const style = c.transition ?? "curve";
  const band = (back: string, middle: string, front: string) =>
    style === "waves" ? wavesSvg(back, middle, front) : curveSvg(middle, front);
  const sie = c.form === "sie";
  const phone = c.contact.phone;
  const ctaHref = phone ? telHref(phone) : "#kontakt";
  const stars = (n: number) => "★★★★★".slice(0, Math.round(n)) + "☆☆☆☆☆".slice(0, 5 - Math.round(n));

  const heroBg = c.hero.image
    ? `background-image: linear-gradient(100deg, rgba(8,12,16,.78) 0%, rgba(8,12,16,.55) 45%, rgba(8,12,16,.08) 80%), url('${esc(c.hero.image)}');`
    : `background: radial-gradient(1200px 600px at 85% 20%, ${p.primary}55, transparent 60%), linear-gradient(135deg, ${p.deep}, ${p.ink});`;

  const services = c.services
    .map(
      (s) => `<article class="card">
  <div class="ic">${icon(s.icon)}</div>
  <h3>${esc(s.title)}</h3>
  <p>${esc(s.text)}</p>
</article>`,
    )
    .join("\n");

  const steps = c.steps
    .map((s, i) => `<li><span class="num">${i + 1}</span><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`)
    .join("\n");

  const quotes = c.reviews.quotes
    .slice(0, 3)
    .map(
      (q) =>
        `<figure class="quote"><div class="qstars">★★★★★</div><blockquote>„${esc(q.text)}“</blockquote><figcaption>${esc(q.author)}</figcaption></figure>`,
    )
    .join("\n");

  const reviews =
    c.reviews.rating && c.reviews.count
      ? `<section class="reviews" id="bewertungen">
  <div class="wrap">
    <div class="score">
      <div class="big">${c.reviews.rating.toFixed(1).replace(".", ",")}</div>
      <div><div class="stars">${stars(c.reviews.rating)}</div><div class="muted">${c.reviews.count} Bewertungen bei Google</div></div>
    </div>
    ${quotes ? `<div class="quotes">${quotes}</div>` : ""}
  </div>
</section>`
      : "";

  const gallery =
    c.gallery.length >= 3
      ? `<section class="gallery" aria-label="Einblicke">
  <div class="wrap grid${c.gallery.length >= 5 ? " mosaic" : ""}">${c.gallery
    .slice(0, 6)
    .map((g, i) => `<img src="${esc(g)}" alt="Einblick ${i + 1}">`)
    .join("")}</div>
</section>`
      : "";

  // Ohne Foto keine leere Farbfläche: Bewertung bzw. Handschrift-Karte statt Bild.
  const aboutVisual = c.about.image
    ? `<div class="photo"><img src="${esc(c.about.image)}" alt="${esc(c.name)}"></div>`
    : `<div class="photo"><div class="ph"><div class="phin">${
        c.reviews.rating && c.reviews.count
          ? `<div class="phbig">${c.reviews.rating.toFixed(1).replace(".", ",")}</div><div class="phstars">★★★★★</div><div>${c.reviews.count} Bewertungen bei Google</div>`
          : `<div class="hand phhand">${esc(c.handwriting ?? c.claim)}</div>`
      }</div></div></div>`;

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
@font-face { font-family: Hand; src: url(fonts/caveat-600.woff2) format("woff2"); font-weight: 600; font-display: swap; }
:root {
  --primary: ${p.primary}; --deep: ${p.deep}; --tint: ${p.tint}; --soft: ${p.soft};
  --ink: ${p.ink}; --paper: ${p.paper}; --muted: #5b6470; --radius: 18px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: Manrope, system-ui, sans-serif; color: var(--ink); background: var(--paper);
  font-size: 17px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
img { max-width: 100%; display: block; }
a { color: inherit; }
.wrap { width: min(1180px, calc(100% - 40px)); margin: 0 auto; }
.note { background: #111; color: #fff; font-size: 13px; text-align: center; padding: 7px 12px; letter-spacing: .01em; }
.note b { color: ${p.soft}; }
header.top { position: sticky; top: 0; z-index: 20; background: rgba(251,250,247,.9); backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(0,0,0,.06); }
header.top .wrap { display: flex; align-items: center; justify-content: space-between; gap: 24px; height: 72px; }
.logo { max-height: 46px; width: auto; }
header.top.dark { background: rgba(11,15,20,.92); color: #fff; border-bottom-color: rgba(255,255,255,.08); }
.wordmark { font-weight: 800; font-size: 20px; letter-spacing: -.01em; }
nav.menu { display: flex; gap: 28px; font-weight: 600; font-size: 15px; }
nav.menu a { text-decoration: none; opacity: .8; }
nav.menu a:hover { opacity: 1; color: var(--primary); }
.btn { display: inline-flex; align-items: center; gap: 10px; background: var(--primary); color: #fff; text-decoration: none;
  font-weight: 700; padding: 14px 24px; border-radius: 999px; transition: transform .2s, background .2s; white-space: nowrap; }
.btn:hover { background: var(--deep); transform: translateY(-1px); }
.btn svg { width: 18px; height: 18px; stroke-width: 2.4; }
.btn.ghost { background: transparent; border: 2px solid rgba(255,255,255,.7); }
.btn.ghost:hover { background: rgba(255,255,255,.12); }
.btn.small { padding: 10px 18px; font-size: 15px; }
.hero { position: relative; height: calc(100vh - 106px); min-height: 640px; max-height: 860px; display: flex; align-items: center; color: #fff;
  ${heroBg} background-size: cover; background-position: center; padding: 30px 0 150px; }
.hero .claim { display: inline-flex; align-items: center; gap: 10px; text-transform: uppercase; letter-spacing: .2em;
  font-weight: 800; font-size: 14px; color: #fff; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.28);
  padding: 9px 16px; border-radius: 999px; backdrop-filter: blur(6px); }
.hero .claim svg { width: 18px; height: 18px; color: ${p.soft}; stroke-width: 2.4; }
.hero h1 { font-size: clamp(46px, 7vw, 96px); line-height: .98; margin: 22px 0 14px; letter-spacing: -.035em;
  font-weight: 800; max-width: 14ch; text-shadow: 0 2px 30px rgba(0,0,0,.25); }
.hero .benefit { font-size: clamp(22px, 2.3vw, 32px); font-weight: 700; line-height: 1.2; margin: 0 0 12px; color: ${p.soft}; max-width: 26ch; }
.hero p.lead { font-size: clamp(16px, 1.4vw, 19px); max-width: 50ch; opacity: .9; margin: 0 0 28px; }
.hero .rating { display: inline-flex; align-items: center; gap: 10px; margin-left: 4px; font-weight: 700; font-size: 15px; }
.hero .rating .s { color: #f6c445; letter-spacing: 2px; font-size: 18px; }
.hero .actions { display: flex; gap: 14px; flex-wrap: wrap; }
.hand { font-family: Hand, cursive; font-weight: 600; }
.hero .hand { font-size: clamp(30px, 3vw, 40px); color: ${p.soft}; transform: rotate(-4deg); display: inline-block; margin-top: 26px; }
.ridge { position: absolute; left: 0; right: 0; bottom: -1px; width: 100%; height: 120px; }
.trust { background: var(--paper); padding: 6px 0 30px; }
.trust ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 14px 34px;
  font-weight: 700; }
.trust li { display: flex; align-items: center; gap: 9px; }
.trust svg { width: 22px; height: 22px; color: var(--primary); stroke-width: 2.6; }
section { position: relative; }
.eyebrow { text-transform: uppercase; letter-spacing: .2em; font-size: 13px; font-weight: 800; color: var(--primary); }
h2 { font-size: clamp(30px, 3.4vw, 46px); line-height: 1.1; letter-spacing: -.02em; margin: 10px 0 18px; font-weight: 800; }
.services { padding: 70px 0 90px; }
.services .head { display: flex; justify-content: space-between; align-items: end; gap: 30px; flex-wrap: wrap; margin-bottom: 34px; }
.services .head p { max-width: 46ch; color: var(--muted); margin: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; }
.card { background: #fff; border-radius: var(--radius); padding: 28px 26px; box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 30px -18px rgba(0,0,0,.25);
  transition: transform .25s, box-shadow .25s; border: 1px solid rgba(0,0,0,.04); }
.card:hover { transform: translateY(-4px); box-shadow: 0 2px 4px rgba(0,0,0,.05), 0 24px 40px -20px rgba(0,0,0,.3); }
.card .ic { width: 54px; height: 54px; border-radius: 16px; background: var(--tint); color: var(--primary); display: grid; place-items: center; margin-bottom: 18px; }
.card .ic svg { width: 28px; height: 28px; stroke-width: 2; }
.card h3 { margin: 0 0 8px; font-size: 20px; letter-spacing: -.01em; }
.card p { margin: 0; color: var(--muted); font-size: 16px; }
.about { padding: 40px 0 110px; }
.about .wrap { display: grid; grid-template-columns: 1.05fr 1fr; gap: 70px; align-items: center; }
.about .photo { position: relative; }
.about .photo::before { content: ""; position: absolute; inset: 28px -22px -22px 28px; background: var(--soft); border-radius: 26px; }
.about .photo img, .about .photo .ph { position: relative; border-radius: 24px; width: 100%; aspect-ratio: 4/3.3; object-fit: cover; }
.about .photo .ph { background: linear-gradient(135deg, var(--primary), var(--deep)); display: grid; place-items: center; color: #fff; text-align: center; }
.phbig { font-size: 120px; font-weight: 800; line-height: 1; letter-spacing: -.04em; }
.phstars { color: #f6c445; font-size: 34px; letter-spacing: 6px; margin: 6px 0 10px; }
.phhand { font-size: 54px; color: #fff; transform: rotate(-4deg); padding: 0 30px; }
.about p { color: var(--muted); white-space: pre-line; }
.about .hand { font-size: 38px; color: var(--primary); transform: rotate(-3deg); display: inline-block; }
.steps { background: var(--primary); color: #fff; padding: 90px 0; }
.edge { position: absolute; left: 0; width: 100%; height: 48px; top: -47px; }
.edge.flip { top: auto; bottom: -47px; transform: scaleY(-1); }
.steps .eyebrow { color: ${p.soft}; }
.steps ol { list-style: none; margin: 40px 0 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 34px; }
.steps .num { display: inline-grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; background: #fff;
  color: var(--primary); font-weight: 800; font-size: 22px; margin-bottom: 14px; }
.steps h3 { margin: 0 0 6px; font-size: 21px; }
.steps p { margin: 0; opacity: .88; }
.reviews { padding: 120px 0 20px; }
.score { display: flex; align-items: center; gap: 22px; margin-bottom: 34px; }
.score .big { font-size: 76px; font-weight: 800; letter-spacing: -.03em; line-height: 1; color: var(--primary); }
.stars, .qstars { color: #f2b01e; font-size: 24px; letter-spacing: 3px; }
.qstars { font-size: 17px; }
.muted { color: var(--muted); }
.quotes { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
.quote { margin: 0; background: #fff; border-radius: var(--radius); padding: 26px; border: 1px solid rgba(0,0,0,.05); }
.quote blockquote { margin: 10px 0 14px; font-size: 16.5px; }
.quote figcaption { font-weight: 700; font-size: 15px; }
.gallery { padding: 10px 0 90px; }
.gallery .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.gallery img { width: 100%; height: 260px; object-fit: cover; border-radius: 14px; }
.gallery .mosaic img:nth-child(1) { grid-row: span 2; height: 534px; }
.contact { background: var(--ink); color: #fff; padding: 40px 0 70px; margin-top: 120px; }
.contact .ridge { position: absolute; top: -119px; bottom: auto; }
.contact .wrap { display: grid; grid-template-columns: 1.1fr 1fr; gap: 60px; align-items: start; }
.contact h2 { color: #fff; }
.contact .eyebrow { color: ${p.soft}; }
.contact dl { margin: 26px 0 0; display: grid; gap: 18px; }
.contact dt { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: .14em; color: ${p.soft}; }
.contact dt svg { width: 18px; height: 18px; }
.contact dd { margin: 4px 0 0 28px; font-size: 18px; }
.contact dd a { text-decoration: none; }
.callcard { background: #fff; color: var(--ink); border-radius: 24px; padding: 36px; box-shadow: 0 30px 60px -30px rgba(0,0,0,.6); }
.callcard h3 { font-size: 28px; margin: 0 0 10px; letter-spacing: -.01em; }
.callcard p { color: var(--muted); margin: 0 0 22px; }
.callcard .tel { display: block; font-size: 30px; font-weight: 800; color: var(--primary); text-decoration: none; margin-bottom: 18px; }
footer { background: #07090c; color: rgba(255,255,255,.6); font-size: 14px; padding: 26px 0; }
footer .wrap { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.mobilecall { display: none; }
@media (max-width: 900px) {
  nav.menu { display: none; }
  .about .wrap, .contact .wrap { grid-template-columns: 1fr; gap: 40px; }
  .steps ol { grid-template-columns: 1fr; }
  .gallery .grid { grid-template-columns: 1fr 1fr; }
  .gallery .mosaic img:nth-child(1) { grid-row: auto; height: 200px; }
  .gallery img { height: 200px; }
  .hero { padding: 60px 0 130px; min-height: 0; height: auto; max-height: none; }
  .hero .rating { margin: 6px 0 0; flex-wrap: wrap; }
  .ridge { height: 70px; }
  .contact .ridge { top: -69px; }
  .contact { margin-top: 70px; }
  .card { display: grid; grid-template-columns: 48px 1fr; gap: 4px 16px; padding: 20px; }
  .card .ic { width: 48px; height: 48px; margin: 0; grid-row: span 2; }
  .card h3 { font-size: 18px; margin: 2px 0 0; }
  .card p { font-size: 15px; }
  .cards { gap: 12px; }
  header.top .btn { display: none; }
  .mobilecall { display: flex; position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 30; justify-content: center; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
  body { padding-bottom: 80px; }
}
</style>
</head>
<body>
<div class="note">Entwurf: <b>So könnte ${sie ? "Ihre" : "eure"} neue Website aussehen.</b> Erstellt von Christian Dobler, nicht öffentlich.</div>
<header class="top${c.logoOnDark ? " dark" : ""}"><div class="wrap">
  <a href="#" aria-label="Start">${brand}</a>
  <nav class="menu"><a href="#leistungen">Leistungen</a><a href="#ueber-uns">Über uns</a><a href="#ablauf">Ablauf</a><a href="#kontakt">Kontakt</a></nav>
  <a class="btn small" href="${ctaHref}">${icon("phone")}${esc(c.cta)}</a>
</div></header>

<section class="hero">
  <div class="wrap">
    <div class="claim">${icon(c.services[0]?.icon ?? "activity")}${esc(c.claim)}</div>
    <h1>${esc(c.name)}</h1>
    <p class="benefit">${esc(c.hero.headline)}</p>
    <p class="lead">${esc(c.hero.text)}</p>
    <div class="actions">
      <a class="btn" href="${ctaHref}">${icon("phone")}${esc(c.cta)}</a>
      ${
        c.reviews.rating && c.reviews.count && c.reviews.rating >= 4.3
          ? `<span class="rating"><span class="s">★★★★★</span>${c.reviews.rating.toFixed(1).replace(".", ",")} · ${c.reviews.count} Google-Bewertungen</span>`
          : `<a class="btn ghost" href="#leistungen">Leistungen ansehen ${icon("arrow-right")}</a>`
      }
    </div>
  </div>
  ${band(p.soft, p.primary, p.paper)}
</section>

<section class="trust"><div class="wrap"><ul>${c.trust.map((t) => `<li>${icon("check")}${esc(t)}</li>`).join("")}</ul></div></section>

<section class="services" id="leistungen"><div class="wrap">
  <div class="head"><div><div class="eyebrow">Leistungen</div><h2>${sie ? "Wobei wir Ihnen helfen" : "Wobei wir dir helfen"}</h2></div>
  <p>${sie ? "Jede Behandlung beginnt mit einem genauen Blick auf Ihre Beschwerden. Danach planen wir gemeinsam, was Sie wirklich weiterbringt." : "Jede Behandlung beginnt mit einem genauen Blick auf deine Beschwerden. Danach planen wir gemeinsam, was dich wirklich weiterbringt."}</p></div>
  <div class="cards">${services}</div>
</div></section>

<section class="about" id="ueber-uns"><div class="wrap">
  ${aboutVisual}
  <div>
    <div class="eyebrow">Über uns</div>
    <h2>${esc(c.about.title)}</h2>
    <p>${esc(c.about.text)}</p>
    ${c.handwriting ? `<div class="hand">${esc(c.handwriting)}</div>` : ""}
  </div>
</div></section>

<section class="steps" id="ablauf">
  ${edgeSvg(style, p.primary)}
  <div class="wrap">
    <div class="eyebrow">So einfach geht's</div>
    <h2>${sie ? "In drei Schritten zu Ihrem Termin" : "In drei Schritten zu deinem Termin"}</h2>
    <ol>${steps}</ol>
  </div>
  ${edgeSvg(style, p.primary, true)}
</section>

${reviews}
${gallery}

<section class="contact" id="kontakt">
  ${band(p.soft, p.primary, p.ink)}
  <div class="wrap">
    <div>
      <div class="eyebrow">Kontakt</div>
      <h2>${sie ? "Wir freuen uns auf Sie." : "Wir freuen uns auf dich."}</h2>
      <dl>
        ${c.contact.address ? `<div><dt>${icon("map-pin")}Adresse</dt><dd>${c.contact.mapsUrl ? `<a href="${esc(c.contact.mapsUrl)}" target="_blank" rel="noopener">${esc(c.contact.address)}</a>` : esc(c.contact.address)}</dd></div>` : ""}
        ${phone ? `<div><dt>${icon("phone")}Telefon</dt><dd><a href="${telHref(phone)}">${esc(phone)}</a></dd></div>` : ""}
        ${c.contact.email ? `<div><dt>${icon("mail")}E-Mail</dt><dd><a href="mailto:${esc(c.contact.email)}">${esc(c.contact.email)}</a></dd></div>` : ""}
        ${c.contact.hours.length > 0 ? `<div><dt>${icon("clock")}Öffnungszeiten</dt><dd>${c.contact.hours.map(esc).join("<br>")}</dd></div>` : ""}
      </dl>
    </div>
    <div class="callcard">
      <h3>${sie ? "Termin vereinbaren" : "Termin ausmachen"}</h3>
      <p>${sie ? "Rufen Sie uns an, wir finden gemeinsam einen passenden Termin, auch kurzfristig." : "Ruf uns an, wir finden gemeinsam einen passenden Termin, auch kurzfristig."}</p>
      ${phone ? `<a class="tel" href="${telHref(phone)}">${esc(phone)}</a>` : ""}
      <a class="btn" href="${ctaHref}">${icon("phone")}${esc(c.cta)}</a>
    </div>
  </div>
</section>
<footer><div class="wrap"><span>© ${esc(c.name)}</span><span>Entwurf von Avelio · Impressum und Datenschutz folgen</span></div></footer>
${phone ? `<a class="btn mobilecall" href="${telHref(phone)}">${icon("phone")}${esc(c.cta)}</a>` : ""}
</body>
</html>`;
}
