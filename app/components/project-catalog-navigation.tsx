export function ProjectCatalogNavigation({ after, nextCursor, count, lifecycle }: {
  after?: string; nextCursor: string | null; count: number; lifecycle?: string;
}) {
  const first = lifecycle ? `/projects?lifecycle=${encodeURIComponent(lifecycle)}` : "/projects";
  const next = nextCursor ? `/projects?${new URLSearchParams({ ...(lifecycle ? { lifecycle } : {}), after: nextCursor })}` : undefined;
  return <nav className="private-actions" aria-label="Project catalog pages">
    {after && <a href={first}>First page</a>}
    <span>{count} {count === 1 ? "project" : "projects"} on this page</span>
    {next && <a href={next}>Next page →</a>}
    <p className="private-note">Refresh from the first page to include newly added projects. Use your browser’s Back button for the previous page.</p>
  </nav>;
}
