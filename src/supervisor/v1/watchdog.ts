import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../persistence/database";
import { actionInboxItemSchemaV1 } from "../../operator-surfaces/v1/validators";
import { ServiceIncidentStore } from "../../services/v1/incident-store";
import { evaluateSupervisorMachineHealthV1, type SupervisorMachineHealthV1,
  type SupervisorMachineProbeV1 } from "./machine-health";
import type { SupervisorOperationsModePortV1 } from "./operations-mode";
import { SupervisorReconcilerV1 } from "./reconciler";

const LOOP_LIVENESS_MS = 120_000;

export class SupervisorWatchdogV1 {
  readonly #incidents:ServiceIncidentStore;
  constructor(private readonly db:DatabaseClient,private readonly tenantId:string,private readonly supervisorId:string,
    private readonly machine:SupervisorMachineProbeV1,private readonly operations:SupervisorOperationsModePortV1,
    private readonly clock:()=>number=Date.now){this.#incidents=new ServiceIncidentStore(db);}

  async cycle():Promise<SupervisorMachineHealthV1>{
    const millis=this.clock();if(!Number.isSafeInteger(millis)||millis<0)throw new Error("supervisor_clock_invalid");
    const at=new Date(millis).toISOString();
    const started=await this.db.transaction(async tx=>{
      const prior=(await tx.query<{version:number|string;last_completed_at:string|Date|null}>(`SELECT version,last_completed_at
        FROM control_supervisor_loop_heads WHERE tenant_id=$1 AND supervisor_id=$2 FOR UPDATE`,
      [this.tenantId,this.supervisorId])).rows[0];
      const version=Number(prior?.version??0)+1;
      await tx.query(`INSERT INTO control_supervisor_loop_heads
        (tenant_id,supervisor_id,version,last_started_at,last_completed_at,state) VALUES($1,$2,$3,$4,NULL,'starting')
        ON CONFLICT(tenant_id,supervisor_id) DO UPDATE SET version=EXCLUDED.version,last_started_at=EXCLUDED.last_started_at,
          last_completed_at=NULL,state='starting'`,[this.tenantId,this.supervisorId,version,at]);
      return{version,lastCompletedAt:prior?.last_completed_at?new Date(prior.last_completed_at).toISOString():null};});
    const sample=await this.machine.sample();
    const loopAlive=started.lastCompletedAt===null||millis-Date.parse(started.lastCompletedAt)<=LOOP_LIVENESS_MS;
    const health=evaluateSupervisorMachineHealthV1(sample,loopAlive);
    await this.db.transaction(async tx=>{
      await tx.query(`INSERT INTO control_supervisor_health_observations
        (id,tenant_id,supervisor_id,loop_version,host_alive,loop_alive,shared_memory_segments,load_one_minute,
         state,safe_reason_codes,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [`supervisor-health:${randomUUID()}`,this.tenantId,this.supervisorId,started.version,health.hostAlive,health.loopAlive,
        health.sharedMemorySegments,health.loadOneMinute,health.healthy?"healthy":"unhealthy",JSON.stringify(health.reasonCodes),at]);
      await tx.query(`UPDATE control_supervisor_loop_heads SET last_completed_at=$3,state=$4
        WHERE tenant_id=$1 AND supervisor_id=$2 AND version=$5`,
      [this.tenantId,this.supervisorId,at,health.healthy?"healthy":"unhealthy",started.version]);});
    if(!health.healthy){
      let pauseFailed=false;
      try{await this.operations.pauseNewStarts({reasonCode:"machine_health_failed",observedAt:at});}catch{pauseFailed=true;}
      // Recording an incident is best-effort from here down: the pause above
      // already protects the machine, so a failure to record (a still-missing
      // grant, a transient blip under the same load that made the machine
      // unhealthy) must not turn a health-check failure into a crashed cycle --
      // especially the first cycle, which host startup awaits directly.
      for(const reason of health.reasonCodes){
        try{
          const result=await this.#incidents.apply({tenantId:this.tenantId,serviceId:this.supervisorId,
            correlationKey:`supervisor.health.${reason}`,observedAt:at,action:"open_or_update",severity:"critical",
            safeReasonCode:reason,safeRemedyCode:"inspect_machine_health"});
          if(result.incident){
            const digest=createHash("sha256").update(result.incident.id).digest("hex").slice(0,32);
            const id=`attention:supervisor:${digest}`;
            const item=actionInboxItemSchemaV1.parse({id,tenantId:this.tenantId,kind:"incident",state:"open",
              requestedAction:"Inspect machine health before resuming new task starts.",reasonCode:reason,
              blockedWorkItemIds:[],legalResponses:[{id:`response:${digest}`,kind:"open_source",
                label:"Inspect recorded machine health",requiresConfirmation:false,available:true}],
              evidence:[{id:`incident:${digest}`,kind:"incident",observedAt:at}],createdAt:at,deliveryState:"not_requested"});
            await this.db.query(`INSERT INTO control_action_inbox
              (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
              VALUES($1,$2,NULL,NULL,'incident','open','not_requested',$3,NULL,$4::jsonb) ON CONFLICT DO NOTHING`,
            [item.id,item.tenantId,item.createdAt,JSON.stringify(item)]);
          }
        }catch{process.stderr.write(`supervisor_incident_record_unavailable ${reason}\n`);}
      }
      if(pauseFailed){
        try{await this.#incidents.apply({tenantId:this.tenantId,serviceId:this.supervisorId,
          correlationKey:"supervisor.health.operations_pause",observedAt:at,action:"open_or_update",severity:"critical",
          safeReasonCode:"operations_pause_unavailable",safeRemedyCode:"inspect_operations_mode"});}
        catch{process.stderr.write("supervisor_incident_record_unavailable operations_pause_unavailable\n");}
      }
    }
    return health;
  }
}

export class SupervisorServiceV1 {
  readonly #watchdog:SupervisorWatchdogV1;readonly #reconciler:SupervisorReconcilerV1;
  constructor(input:Readonly<{db:DatabaseClient;tenantId:string;supervisorId:string;machine:SupervisorMachineProbeV1;
    operations:SupervisorOperationsModePortV1;clock?:()=>number}>){
    const clock=input.clock??Date.now;this.#watchdog=new SupervisorWatchdogV1(input.db,input.tenantId,input.supervisorId,
      input.machine,input.operations,clock);this.#reconciler=new SupervisorReconcilerV1(input.db,input.tenantId,clock);}
  async cycle(){const health=await this.#watchdog.cycle();const suspectAgents=await this.#reconciler.refreshAgentHeartbeatHealth();
    const waits=await this.#reconciler.releaseDueProviderWaits();const reconciled=await this.#reconciler.reconcileStalled();
    return Object.freeze({health,waits,reconciled,suspectAgents});}
}
