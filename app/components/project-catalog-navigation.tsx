export function ProjectCatalogNavigation({ after, nextCursor, count }: { after?: string; nextCursor: string | null; count: number }) {
  return <nav className="private-actions" aria-label="Project catalog pages">
    {after && <a href="/projects">First page</a>}
    <span>{count} {count === 1 ? "project" : "projects"} on this page</span>
    {nextCursor && <a href={`/projects?after=${encodeURIComponent(nextCursor)}`}>Next page →</a>}
    <p className="private-note">Refresh from the first page to include newly added projects. Use your browser’s Back button for the previous page.</p>
  </nav>;
}
