/** Browser-safe adapter identity for the controller-worker remote route. Kept
 * apart from remote-worker-delivery.ts so client bundles never pull in
 * server-only delivery and host-value code. */
export const CONTROLLER_WORKER_REMOTE_ADAPTER_V1 = "connector:controller-worker-remote-v1" as const;
