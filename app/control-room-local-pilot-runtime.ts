import type { IdeaLabProtectedRuntimeV1 } from "@/app/idea-lab-protected-runtime";
import type { ConnectionCenterProtectedRuntimeV1 } from "@/app/connection-center-protected-runtime";
import type { ProjectWorkspaceProtectedRuntimeV1 } from "@/app/project-workspace-protected-runtime";
import type { ProjectEventReadRequestV1, ProjectEventReadSourceV1 } from "@/src/project-events/v1";
import { createControlRoomLocalPilotRuntimeV1,type ControlRoomLocalPilotRuntimeV1,type LocalPilotOwnerSessionServiceV1 } from "@/src/local-pilot/v1";

interface LocalPilotPortsV1{
  ideaLab:IdeaLabProtectedRuntimeV1;
  projectWorkspace:ProjectWorkspaceProtectedRuntimeV1;
  projectEvents:{scopeAuthority:ProjectWorkspaceProtectedRuntimeV1["scopeAuthority"];eventSource:ProjectEventReadSourceV1};
  connectionCenter:ConnectionCenterProtectedRuntimeV1;
  sessionIssuer:Pick<LocalPilotOwnerSessionServiceV1,"issue"|"verify">;
}
let ports:LocalPilotPortsV1|undefined;

function configuration(){const viteEnv=(import.meta as ImportMeta&{env?:{PROD:boolean}}).env;
  const production=viteEnv?.PROD??process.env.NODE_ENV==="production";
  if(production||process.env.CONTROL_ROOM_LOCAL_PILOT_MODE!=="repository_fake")return undefined;
  const encoded=process.env.CONTROL_ROOM_LOCAL_PILOT_MASTER_KEY_B64??"",master=Buffer.from(encoded,"base64");
  const dataDir=process.env.CONTROL_ROOM_LOCAL_PILOT_DATA_DIR??"",ownerCodeDigest=process.env.CONTROL_ROOM_LOCAL_PILOT_OWNER_CODE_DIGEST??"";
  if(master.byteLength!==32||master.toString("base64")!==encoded||!dataDir||!/^sha256:[a-f0-9]{64}$/.test(ownerCodeDigest))return undefined;
  return{mode:"repository_fake"as const,origin:"http://127.0.0.1:3000"as const,dataDir,repositoryRoot:process.cwd(),
    masterKey:new Uint8Array(master),ownerCodeDigest};}

export function isControlRoomLocalPilotConfiguredV1():boolean{return configuration()!==undefined;}
export function getControlRoomLocalPilotPortsV1():LocalPilotPortsV1|undefined{if(ports)return ports;const config=configuration();if(!config)return undefined;
  const ready:Promise<ControlRoomLocalPilotRuntimeV1>=createControlRoomLocalPilotRuntimeV1(config);
  const ownerSession={verify:(credential:unknown,now:string)=>ready.then(runtime=>runtime.ownerSession.verify(credential,now))};
  const ideaLab:IdeaLabProtectedRuntimeV1={ownerSession,operatorService:{create:(value,authentication)=>ready.then(runtime=>runtime.operatorService.create(value,authentication)),
    start:(value,authentication)=>ready.then(runtime=>runtime.operatorService.start(value,authentication)),cancel:(value,authentication)=>ready.then(runtime=>runtime.operatorService.cancel(value,authentication)),
    synthesize:(value,authentication)=>ready.then(runtime=>runtime.operatorService.synthesize(value,authentication)),list:authentication=>ready.then(runtime=>runtime.operatorService.list(authentication)),
    get:(sessionId,authentication)=>ready.then(runtime=>runtime.operatorService.get(sessionId,authentication))},
    ownerDecisionService:{apply:input=>ready.then(runtime=>runtime.ownerDecisionService.apply(input))},
    lifecycleService:{transition:(value,authentication)=>ready.then(runtime=>runtime.lifecycleService.transition(value,authentication)),
      get:(projectId,authentication)=>ready.then(runtime=>runtime.lifecycleService.get(projectId,authentication))}};
  const projectWorkspace:ProjectWorkspaceProtectedRuntimeV1={scopeAuthority:{authorize:value=>ready.then(runtime=>runtime.scopeAuthority.authorize(value))}as ProjectWorkspaceProtectedRuntimeV1["scopeAuthority"],
    readSource:{read:value=>ready.then(runtime=>runtime.readSource.read(value))}};
  const projectEvents={scopeAuthority:projectWorkspace.scopeAuthority,eventSource:{read:(value:ProjectEventReadRequestV1)=>ready.then(runtime=>runtime.projectEventSource.read(value))}};
  const connectionCenter:ConnectionCenterProtectedRuntimeV1={ownerSession,
    rosterSource:{read:value=>ready.then(runtime=>runtime.connectionRosterSource.read(value))},
    freshnessSource:{read:value=>ready.then(runtime=>runtime.connectionFreshnessSource.read(value))}};
  const sessionIssuer:Pick<LocalPilotOwnerSessionServiceV1,"issue"|"verify">={issue:(request,code)=>ready.then(runtime=>runtime.ownerSession.issue(request,code)),
    verify:(credential,now)=>ready.then(runtime=>runtime.ownerSession.verify(credential,now))};
  ports=Object.freeze({ideaLab,projectWorkspace,projectEvents,connectionCenter,sessionIssuer});return ports;}
