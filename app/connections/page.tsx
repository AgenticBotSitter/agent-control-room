import type { Metadata } from "next";
import Link from "next/link";
import { ConnectionCenter } from "@/app/components/connection-center";

export const metadata: Metadata = { title: "Connections", description: "Protected Control Room agent connection inventory." };

export default function ConnectionsPage() {
  return <div className="detail-shell"><main className="detail-main" tabIndex={-1}>
    <Link className="detail-back" href="/" prefetch={false}>← Back to Control Room</Link>
    <header className="detail-hero"><div><p className="eyebrow">Control Room infrastructure</p><h1>Connection Center</h1>
      <p>See which agent machines are enrolled, which Hermes version they match, and exactly what still blocks safe use.</p></div>
      <span className="prototype-badge">Protected read</span></header>
    <ConnectionCenter />
  </main></div>;
}
