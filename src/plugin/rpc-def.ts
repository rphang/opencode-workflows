// The `dynamic-workflows` RPC definition (X12, X13): pure data with plain JSON Schema and no runtime
// imports, so both the server plugin (ctx.rpc.register) and the TUI plugin (ctx.client.rpc) use it.
//
// Methods (called through the server API, POST /api/rpc/dynamic-workflows/<method>):
//   list    {sessionID?, all?, limit?}  → {ok, directory, seq, epoch, runs: RunView[], agents: AgentView[]}
//   status  {runId}                     → {ok, run: RunView, agents: AgentView[]} | {ok:false, message}
//   control {runId, action, …}          → {ok, message}   (stop, stop_agent, pause, resume, message)
// Events (on the global /api/event stream as `rpc.dynamic-workflows.<name>`):
//   delta    {seq, epoch, runs, agents} coalesced to at most 4 per second (epoch: the plugin instance)
//   finished {runId, status, …}         right away when a run ends

export const RPC_ID = "dynamic-workflows"

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
})

/** Size bounds checked by opencode before a handler runs (MAX_MESSAGE_CHARS is 4000; tests keep them equal). */
export const MAX_TEXT_CHARS = 4000
export const MAX_NAME_CHARS = 200
const id = { type: "string", maxLength: MAX_NAME_CHARS }
const name = { type: "string", maxLength: MAX_NAME_CHARS }

export const CONTROL_RPC_ACTIONS = ["stop", "stop_agent", "pause", "resume", "message"] as const

export const definition = {
  id: RPC_ID,
  methods: {
    list: {
      input: object({
        sessionID: id,
        all: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      }),
      output: { type: "object" },
    },
    status: {
      input: object({ runId: id }, ["runId"]),
      output: { type: "object" },
    },
    control: {
      input: object(
        {
          runId: id,
          action: { type: "string", enum: [...CONTROL_RPC_ACTIONS] },
          agentIndex: { type: "integer", minimum: 0 },
          label: name,
          phase: name,
          all: { type: "boolean" },
          text: { type: "string", maxLength: MAX_TEXT_CHARS },
          urgent: { type: "boolean" },
        },
        ["runId", "action"],
      ),
      output: { type: "object" },
    },
  },
  events: {
    delta: { schema: { type: "object" } },
    finished: { schema: { type: "object" } },
  },
} as const

export type RpcDefinition = typeof definition
