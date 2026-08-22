import { transcriptionScenarios } from "@/src/simulator/scenarios";

const allowed = new Set(Object.keys(transcriptionScenarios));

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { scenario?: string };
  const scenario = body.scenario ?? "automatic";
  if (!allowed.has(scenario)) {
    return Response.json({ error: "unsupported_synthetic_scenario" }, { status: 400 });
  }
  return Response.json({
    synthetic: true,
    commandSent: false,
    decision: transcriptionScenarios[scenario as keyof typeof transcriptionScenarios],
  }, { headers: { "cache-control": "no-store" } });
}
