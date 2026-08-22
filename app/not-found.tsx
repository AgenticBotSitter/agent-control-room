import Link from "next/link";

export default function NotFound() {
  return <main className="not-found"><div><p className="eyebrow">Not found</p><h1>That Control Room record is not in this fixture.</h1><p className="hero-copy">No live adapters are connected in CR-0 through CR-2.</p><Link className="primary-button" href="/" prefetch={false}>Return to Control Room</Link></div></main>;
}
