/**
 * Ansprechpartner aus dem Firmennamen (04.10.2026, Christian: "Hallo Team Christina Heider Physiotherapeutin" ist zu
 * generisch). Viele Praxen heißen wie ihre Inhaberin; erkannt wird ein gängiger Vorname direkt neben einem Nachnamen.
 * Das Geschlecht wird nie geraten: die Anrede nutzt den vollen Namen ohne Frau/Herr.
 */

const FIRST_NAMES = new Set(
  `Alexander Alexandra Alina Andrea Andreas Angelika Anja Anna Anne Annette Antje Anton Barbara Bastian Bea Beate
  Benedikt Benjamin Bernd Bernhard Bettina Birgit Brigitte Carina Carmen Carolin Caroline Christa Christian Christiane
  Christina Christine Christoph Claudia Cornelia Dagmar Daniel Daniela David Denise Dennis Dieter Dirk Dominik Doris
  Elena Elisabeth Elke Eva Fabian Felix Florian Franz Franziska Frank Gabriele Georg Gerhard Gisela Hannah Hannes Hans
  Heike Helena Helmut Hubert Ines Ingrid Iris Isabel Isabella Isabell Jakob Jan Jana Janina Jasmin Jennifer Jessica
  Johann Johanna Johannes Jonas Josef Julia Julian Juliane Jürgen Karin Karl Katharina Kathrin Katja Katrin Kerstin
  Kevin Kilian Klaus Konstantin Kristina Laura Lea Lena Leonie Lisa Lorenz Lukas Lucas Magdalena Maike Manfred
  Manuel Manuela Marco Marcus Maren Maria Marie Marina Mario Marion Markus Martin Martina Mathias Matthias Max
  Maximilian Melanie Michael Michaela Miriam Monika Nadine Natalie Nicole Niklas Nina Nicola Norbert Oliver Patrick
  Patricia Paul Peter Petra Philipp Rainer Ralf Ramona Raphael Regina Reinhard Renate Robert Roland Sabine Sabrina
  Sandra Sara Sarah Sebastian Silke Simon Simone Sonja Sophia Sophie Stefan Stefanie Stephan Stephanie Susanne
  Svenja Sven Sylvia Tamara Tanja Teresa Theresa Thomas Tim Tobias Ulrike Ursula Valentin Valerie Vanessa Verena
  Veronika Viktoria Werner Wolfgang Yvonne Mike Tina Toni Vroni Resi Sepp Beni Leni Hanna Corinna Kathrin Nora
  Larissa Selina Vera Judith Lydia Theresia Rosemarie Gertrud Ludwig Leonhard Korbinian Quirin Vitus Alois`
    .split(/\s+/)
    .filter(Boolean),
);

/** Kein Nachname, auch wenn es neben einem Vornamen steht ("Franz Physio"). */
const GENERIC = new Set(
  "Physio Physiotherapie Physiotherapeutin Physiotherapeut Praxis Therapie Therapiezentrum Team Zentrum Massage Reha Gesundheit Training Sport Fitness Osteopathie Ergotherapie".split(
    " ",
  ),
);

const WORD = /^[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?$/;

/** "Christina Heider Physiotherapeutin" → "Christina Heider"; "Physiotherapie Pickelmann Mike" → "Mike Pickelmann". */
export function personFromCompanyName(companyName: string): string | null {
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
