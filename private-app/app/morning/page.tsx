import type { Metadata } from "next";
import { PrivateMorningSummary } from "./morning-workspace";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Morning summary · Control Room" };
export default function MorningPage() { return <PrivateMorningSummary />; }
