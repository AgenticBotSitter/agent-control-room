function absoluteLink(href: string, base: string) {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

function htmlAttribute(tag: string, name: string) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] || match?.[2] || match?.[3] || "";
}

export function isFeedDocument(text: string) {
  return /<(?:rss|feed|(?:[\w-]+:)?RDF)[\s>]/i.test(text.slice(0, 1500));
}

export function discoveredFeedLinks(html: string, base: string) {
  return [...html.matchAll(/<link\b[^>]*>/gi)].flatMap(([tag]) => {
    const type = htmlAttribute(tag, "type").toLowerCase();
    if (!/^(?:application\/(?:rss\+xml|atom\+xml|rdf\+xml|xml)|text\/xml)$/.test(type)) return [];
    const href = htmlAttribute(tag, "href");
    return href ? [absoluteLink(href, base)] : [];
  }).filter(Boolean);
}
