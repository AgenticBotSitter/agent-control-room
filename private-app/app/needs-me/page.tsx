import type { Metadata } from "next";
import { PrivateNeedsMe } from "./workspace";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Action Inbox · Control Room" };
export default function NeedsMePage() { return <PrivateNeedsMe />; }
