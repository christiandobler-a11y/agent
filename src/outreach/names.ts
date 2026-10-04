import { FEMININE_ROLE } from "../pipeline/crawl/impressum.js";

/**
 * Ansprechpartner aus dem Firmennamen (04.10.2026, Christian: "Hallo Team Christina Heider Physiotherapeutin" ist zu
 * generisch). Viele Praxen heißen wie ihre Inhaberin; erkannt wird ein gängiger Vorname direkt neben einem Nachnamen.
 * Frau/Herr: aus dem Impressum, einer weiblichen Berufsbezeichnung oder einem eindeutigen Vornamen (unten).
 */

/**
 * Eindeutige Vornamen (04.10.2026, Christian: drei Probeläufe hintereinander "Liebes Praxisteam", weil im Impressum
 * nur "Inhaber: Max Huber" steht). Nur Namen, die in Deutschland praktisch immer zu einem Geschlecht gehören;
 * mehrdeutige (Toni, Kim, Nicola, Sascha, Maxi, Luca, Robin …) stehen in keiner Liste und gehen weiter ans Team.
 */
const FEMALE = new Set(
  `Alexandra Alina Andrea Angelika Anja Anna Anne Annette Antje Barbara Bea Beate Bettina Birgit Brigitte Carina
  Carmen Carolin Caroline Christa Christiane Christina Christine Claudia Cornelia Dagmar Daniela Denise Doris Elena
  Elisabeth Elke Eva Franziska Gabriele Gisela Hannah Hanna Heike Helena Ines Ingrid Iris Isabel Isabella Isabell Jana
  Janina Jasmin Jennifer Jessica Johanna Julia Juliane Karin Katharina Kathrin Katja Katrin Kerstin Kristina Laura Lea
  Lena Leonie Lisa Magdalena Maike Manuela Maren Maria Marie Marina Marion Martina Melanie Michaela Miriam Monika
  Nadine Natalie Nicole Nina Patricia Petra Ramona Regina Renate Sabine Sabrina Sandra Sara Sarah Silke Simone Sonja
  Sophia Sophie Stefanie Stephanie Susanne Svenja Sylvia Tamara Tanja Teresa Theresa Tina Ulrike Ursula Valerie
  Vanessa Verena Veronika Viktoria Yvonne Vroni Resi Leni Corinna Nora Larissa Selina Vera Judith Lydia Theresia
  Rosemarie Gertrud Kathrin Anke Astrid Bianca Diana Elena Evelyn Gudrun Heidi Helga Ilse Irene Jacqueline Jutta
  Kirsten Lara Lucia Marlene Mareike Nadja Nathalie Olga Pia Rebecca Rita Rosa Ruth Saskia Stella Tatjana Uta Ute
  Waltraud Anita Alexandra Agnes Amelie Annika Antonia Carla Clara Emilia Emma Franka Greta Ida Ilona Jenny Josefine
  Katharina Kathi Laila Lilli Luisa Luise Mia Nele Paula Rahel Romy Ronja Svetlana Tabea Vivien Zoe`
    .split(/\s+/)
    .filter(Boolean),
);
const MALE = new Set(
  `Alexander Andreas Anton Bastian Benedikt Benjamin Bernd Bernhard Christian Christoph Daniel David Dennis Dieter
  Dirk Dominik Fabian Felix Florian Franz Frank Georg Gerhard Hannes Hans Helmut Hubert Jakob Jan Johann Johannes
  Jonas Josef Julian Jürgen Karl Kevin Kilian Klaus Konstantin Lorenz Lukas Lucas Manfred Manuel Marco Marcus Mario
  Markus Martin Mathias Matthias Max Maximilian Michael Niklas Norbert Oliver Patrick Paul Peter Philipp Rainer Ralf
  Raphael Reinhard Robert Roland Sebastian Simon Stefan Stephan Sven Thomas Tim Tobias Valentin Werner Wolfgang Mike
  Sepp Beni Ludwig Leonhard Korbinian Quirin Vitus Alois Armin Axel Benno Bruno Carsten Dietmar Egon Emil Erich Erwin
  Ferdinand Fritz Gregor Günter Günther Harald Heinz Herbert Holger Horst Ingo Jens Jörg Kai-Uwe Konrad Kurt Lars Leon
  Lothar Ludger Marc Marcel Mathis Moritz Nico Nils Otto Pascal Rene René Richard Rudolf Rupert Siegfried Steffen
  Sören Thorsten Torsten Udo Uwe Volker Walter Wilhelm Xaver Alfons Anderl Bene Ben Elias Finn Florian Gabriel Hannes
  Hermann Ignaz Jonathan Julius Leopold Linus Magnus Matthäus Michi Noah Oskar Severin Timo Vinzenz`
    .split(/\s+/)
    .filter(Boolean),
);
const FIRST_NAMES = new Set([...FEMALE, ...MALE, ...["Toni", "Nicola"]]);

/** "Herr"/"Frau" aus einem eindeutigen Vornamen ("Anna Berg" → Frau), sonst `null`. Doppelnamen nach dem ersten Teil. */
export function salutationFromFirstName(fullName: string): "Herr" | "Frau" | null {
  const first = fullName.trim().split(/\s+/)[0]?.split("-")[0] ?? "";
  if (FEMALE.has(first) && !MALE.has(first)) return "Frau";
  if (MALE.has(first) && !FEMALE.has(first)) return "Herr";
  return null;
}

/** Kein Nachname, auch wenn es neben einem Vornamen steht ("Franz Physio"). */
const GENERIC = new Set(
  "Physio Physiotherapie Physiotherapeutin Physiotherapeut Praxis Therapie Therapiezentrum Team Zentrum Massage Reha Gesundheit Training Sport Fitness Osteopathie Ergotherapie".split(
    " ",
  ),
);

const WORD = /^[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?$/;

/** "Christina Heider Physiotherapeutin" → "Christina Heider"; "Physiotherapie Pickelmann Mike" → "Mike Pickelmann". */
export function personFromCompanyName(companyName: string): string | null {
  return personInCompanyName(companyName)?.name ?? null;
}

/** Wie oben, dazu "Frau", wenn eine weibliche Berufsbezeichnung im Namen steht ("… Physiotherapeutin"). */
export function personInCompanyName(companyName: string): { name: string; salutation: "Frau" | null } | null {
  const name = findName(companyName);
  if (!name) return null;
  return { name, salutation: FEMININE_ROLE.test(companyName) ? "Frau" : null };
}

function findName(companyName: string): string | null {
  const words = companyName
    .replace(/["„“”]/g, "")
    .split(/\s+[|–—-]\s+|\s*\|\s*|,|:/)[0]!
    .split(/\s+/)
    .filter(Boolean);
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i]!, words[i + 1]!];
    if (!WORD.test(a) || !WORD.test(b) || GENERIC.has(a) || GENERIC.has(b)) continue;
    if (FIRST_NAMES.has(a) && !FIRST_NAMES.has(b)) return `${a} ${b}`;
    if (FIRST_NAMES.has(b) && !FIRST_NAMES.has(a) && i + 2 === words.length) return `${b} ${a}`;
  }
  return null;
}
