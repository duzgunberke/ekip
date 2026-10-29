export function legacyRouteHref(
  location: { searchStr: string; hash: string },
  path: string
) {
  return `${path}${location.searchStr}${location.hash}`
}
