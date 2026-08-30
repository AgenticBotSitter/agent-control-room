import { assertSafeProjection } from "../../contracts/v1/validators";
import { assertNoSecretMaterial, canonicalJson } from "../../security";
import { mcpSafeIdV1 } from "./schemas";
import {
  CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1,
  type ControlRoomMcpAccessGrantV1,
  type ControlRoomMcpJsonRpcResponseV1,
  type ControlRoomMcpToolDefinitionV1,
  type ControlRoomMcpToolNameV1,
  type ControlRoomMcpToolResultV1,
} from "./types";

export interface ControlRoomMcpClientTransportV1 {
  send(input: { headers: Record<string, string>; request: Record<string, unknown>; accessGrant: ControlRoomMcpAccessGrantV1;
    bearerToken: string }): Promise<ControlRoomMcpJsonRpcResponseV1>;
}

export class ControlRoomMcpClientErrorV1 extends Error {
  constructor(public readonly safeCode: "transport_failed" | "protocol_invalid" | "tool_denied") {
    super(safeCode); this.name = "ControlRoomMcpClientErrorV1";
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key,index) => key === expected[index]);
}

/** Typed northbound client. Authentication material is private and never appears in evidence or returned tool data. */
export class ControlRoomMcpClientV1 {
  readonly #grant: ControlRoomMcpAccessGrantV1;
  readonly #bearerToken: string;

  constructor(private readonly transport: ControlRoomMcpClientTransportV1, authentication: {
    accessGrant: ControlRoomMcpAccessGrantV1; bearerToken: string;
  }) {
    this.#grant = structuredClone(authentication.accessGrant); this.#bearerToken = authentication.bearerToken;
    if (typeof this.#bearerToken !== "string" || this.#bearerToken.length < 32) throw new ControlRoomMcpClientErrorV1("protocol_invalid");
  }

  async discover(requestId: string): Promise<{ protocolVersion: typeof CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1; authorityModel: "per_request_scoped" }> {
    const result = await this.exchange("server/discover",requestId);
    if (!exactKeys(result,["protocolVersion","capabilities","authorityModel"]) || result.protocolVersion !== CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1
      || result.authorityModel !== "per_request_scoped" || !exactKeys(result.capabilities,["tools"])) throw new ControlRoomMcpClientErrorV1("protocol_invalid");
    return { protocolVersion: CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1, authorityModel: "per_request_scoped" };
  }

  async listTools(requestId: string): Promise<ControlRoomMcpToolDefinitionV1[]> {
    const result = await this.exchange("tools/list",requestId,{});
    if (!exactKeys(result,["tools"]) || !Array.isArray(result.tools)) throw new ControlRoomMcpClientErrorV1("protocol_invalid");
    const tools = result.tools as ControlRoomMcpToolDefinitionV1[];
    if (tools.some((tool) => !exactKeys(tool,["name","title","description","inputSchema","outputSchema","annotations"]))) {
      throw new ControlRoomMcpClientErrorV1("protocol_invalid");
    }
    assertNoSecretMaterial(tools,"MCP tool discovery");
    return structuredClone(tools);
  }

  async callTool(name: ControlRoomMcpToolNameV1, args: Record<string, unknown>, requestId: string): Promise<ControlRoomMcpToolResultV1> {
    this.assertRequestId(requestId); assertNoSecretMaterial(args,"MCP client tool input");
    const result = await this.exchange("tools/call",requestId,{ name, arguments: args,
      _meta: { "com.control-room/requestId": requestId } },name);
    const expected = (result as { isError?: unknown }).isError === undefined ? ["content","structuredContent"] : ["content","structuredContent","isError"];
    if (!exactKeys(result,expected) || !Array.isArray(result.content) || !result.structuredContent
      || typeof result.structuredContent !== "object" || Array.isArray(result.structuredContent)
      || (result.isError !== undefined && result.isError !== true) || result.content.length !== 1
      || !exactKeys(result.content[0],["type","text"]) || result.content[0].type !== "text"
      || result.content[0].text !== canonicalJson(result.structuredContent)) throw new ControlRoomMcpClientErrorV1("protocol_invalid");
    assertSafeProjection(result.structuredContent); assertNoSecretMaterial(result,"MCP client tool result");
    return structuredClone(result) as unknown as ControlRoomMcpToolResultV1;
  }

  evidence(): { protocolVersion: typeof CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1; grantId: string; clientId: string; tenantId: string;
    scopes: string[]; projectIds: string[]; authenticationIncluded: false } {
    return { protocolVersion: CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1, grantId: this.#grant.body.grantId, clientId: this.#grant.body.clientId,
      tenantId: this.#grant.body.tenantId, scopes: [...this.#grant.body.scopes], projectIds: [...this.#grant.body.projectIds], authenticationIncluded: false };
  }

  private async exchange(method: "server/discover" | "tools/list" | "tools/call", requestId: string, params?: Record<string, unknown>,
    toolName?: ControlRoomMcpToolNameV1): Promise<Record<string, unknown>> {
    this.assertRequestId(requestId);
    let response: ControlRoomMcpJsonRpcResponseV1;
    try { response = await this.transport.send({ headers: { "MCP-Protocol-Version": CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1,
      "Mcp-Method": method, ...(toolName ? { "Mcp-Name": toolName } : {}) }, request: { jsonrpc: "2.0", id: requestId, method,
      ...(params === undefined ? {} : { params }) }, accessGrant: structuredClone(this.#grant), bearerToken: this.#bearerToken }); }
    catch { throw new ControlRoomMcpClientErrorV1("transport_failed"); }
    if (!exactKeys(response,"error" in response ? ["jsonrpc","id","error"] : ["jsonrpc","id","result"])
      || response.jsonrpc !== "2.0" || response.id !== requestId) throw new ControlRoomMcpClientErrorV1("protocol_invalid");
    if ("error" in response) throw new ControlRoomMcpClientErrorV1("protocol_invalid");
    if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) throw new ControlRoomMcpClientErrorV1("protocol_invalid");
    return response.result as Record<string, unknown>;
  }

  private assertRequestId(requestId: string): void {
    if (!mcpSafeIdV1.safeParse(requestId).success) throw new ControlRoomMcpClientErrorV1("protocol_invalid");
  }
}
