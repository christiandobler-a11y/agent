import { resolveMx } from "node:dns/promises";

/**
 * Nimmt die Domain einer Adresse überhaupt Mails an (MX-Eintrag)? Unzustellbare Mails schaden dem Ruf von
 * Christians Postfach bei Spamfiltern; ohne MX geht der Lead als Brief in den Plan.
 */

export type MxCheck = (address: string) => Promise<boolean>;

export function createMxCheck(
  lookup: (domain: string) => Promise<unknown[]> = resolveMx,
  timeoutMs = 5000,
): MxCheck {
  const cache = new Map<string, Promise<boolean>>();
  return (address) => {
    const domain = address.split("@")[1]?.trim().toLowerCase();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return Promise.resolve(false);
    let p = cache.get(domain);
    if (!p) {
      p = Promise.race([
        lookup(domain).then((r) => r.length > 0),
        // Zeitüberschreitung: nicht bestrafen (lieber eine Mail zu viel als einen Lead verlieren).
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs).unref()),
      ]).catch(() => false);
      cache.set(domain, p);
    }
    return p;
  };
}
