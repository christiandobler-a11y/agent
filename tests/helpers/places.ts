import type { Place } from "../../src/pipeline/research/places.js";

/** Synthetischer Places-Treffer (Form wie die echte API-Antwort), standardmäßig im Landkreis Rosenheim. */
export function makePlace(
  overrides: Partial<Place> & { id: string; name?: string; postalCode?: string },
): Place {
  const { name, postalCode, ...rest } = overrides;
  return {
    displayName: { text: name ?? `Firma ${overrides.id}` },
    formattedAddress: `Hauptstraße 1, ${postalCode ?? "83043"} Bad Aibling`,
    addressComponents: [
      { longText: "1", types: ["street_number"] },
      { longText: "Hauptstraße", types: ["route"] },
      { longText: "Bad Aibling", types: ["locality", "political"] },
      { longText: "Rosenheim", types: ["administrative_area_level_3", "political"] },
      { longText: postalCode ?? "83043", types: ["postal_code"] },
    ],
    location: { latitude: 47.86, longitude: 12.01 },
    types: ["bicycle_store", "store", "point_of_interest", "establishment"],
    primaryType: "bicycle_store",
    primaryTypeDisplayName: { text: "Fahrradgeschäft" },
    websiteUri: `https://www.${overrides.id}.de/`,
    nationalPhoneNumber: "08061 12345",
    rating: 4.6,
    userRatingCount: 80,
    businessStatus: "OPERATIONAL",
    photos: [{}, {}],
    ...rest,
  };
}
