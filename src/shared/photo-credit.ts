/** Public provenance only; never original image URLs or provider credentials. */
export type PhotoCredit = {
  title: string;
  attribution: string;
  source: "Wikimedia Commons" | "NASA";
  sourceUrl: string;
  license: string;
  licenseUrl: string;
};

function httpsUrl(value: unknown, host: string, prefix: string) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === host &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith(prefix)
    );
  } catch {
    return false;
  }
}

export function isPhotoCredit(value: unknown): value is PhotoCredit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credit = value as Record<string, unknown>;
  const text = (key: string, limit: number) =>
    typeof credit[key] === "string" &&
    credit[key].length > 0 &&
    credit[key].length <= limit &&
    !/\p{Cc}/u.test(credit[key]);
  return (
    text("title", 200) &&
    text("attribution", 1000) &&
    text("license", 80) &&
    (credit.source === "Wikimedia Commons"
      ? httpsUrl(credit.sourceUrl, "commons.wikimedia.org", "/wiki/File:") &&
        httpsUrl(credit.licenseUrl, "creativecommons.org", "/")
      : credit.source === "NASA" &&
        httpsUrl(credit.sourceUrl, "images.nasa.gov", "/details/") &&
        credit.licenseUrl ===
          "https://www.nasa.gov/nasa-brand-center/images-and-media/")
  );
}

export function projectPhotoCredit(credit: PhotoCredit): PhotoCredit {
  return {
    title: credit.title,
    attribution: credit.attribution,
    source: credit.source,
    sourceUrl: credit.sourceUrl,
    license: credit.license,
    licenseUrl: credit.licenseUrl,
  };
}
