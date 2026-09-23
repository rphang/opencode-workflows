// Per-agent message window for steering (docs/design/steering-and-live-tree.md §A.4, PARITY X01–X04).
// Host-agnostic: the engine creates one mailbox per live agent, and the host runner attaches a
// sender once the agent has a session.
//
//            attach()           first prompt sent         turn finished (wait() resolved)
//   pending ─────────► between ────────────────► open ─────────────────────────────► finishing
//   (queued: held,    (messages wait              ▲                                      │
//    go into the       for open())                └──────── next (schema-retry) turn ◄───┤
//    first prompt)                                                                       │ seal
//   any state ───────────────────────────── stop / settle ──────────────────────────────► closed
//
// post() decides from the state synchronously (JS is single-threaded, so the check and the state
// change cannot interleave): pending → held; between → sent at open(); open → sent now; finishing →
// refused `finishing`; closed → refused `finished`. close() awaits every send that started while the
// window was open, so a message accepted just before the turn ended is always verified by the runner.

export const MAX_MESSAGE_CHARS = 4000
export const MAX_MESSAGES_PER_AGENT = 20
export const MAX_HELD_MESSAGES = 5
/** Message text kept in AgentRecord.messages (the full text is in journal.jsonl). */
export const RECORD_TEXT_CHARS = 500

export type MessageFrom = "user" | "model"
/** command: /workflows msg; tool: workflow_control; rpc: the dynamic-workflows RPC (the TUI tree or another server-API client). */
export type MessageVia = "command" | "tool" | "rpc"

export interface AgentMessage {
  /** `wm_<agentIndex>_<n>`, unique within a run. */
  id: string
  from: MessageFrom
  via: MessageVia
  text: string
  urgent: boolean
  at: number
}

export type MessageStatus = "held" | "sent" | "delivered" | "undelivered" | "refused"

/** One message as shown on the agent (AgentRecord.messages). */
export interface MessageRecord {
  id: string
  from: MessageFrom
  via: MessageVia
  urgent: boolean
  at: number
  /** Clipped to RECORD_TEXT_CHARS. */
  text: string
  status: MessageStatus
  error?: string
}

export type RefusalReason = "finished" | "finishing" | "submitted" | "limit" | "send_failed"

export type PostResult =
  | { ok: true; state: "sent"; deliveryId: string }
  | { ok: true; state: "held" }
  | { ok: false; reason: RefusalReason; detail?: string }

export type MailboxState = "pending" | "between" | "open" | "finishing" | "closed"

/** A message sent in one window: its id and the id of the context message it becomes. */
export interface SentMessage {
  id: string
  deliveryId: string
}

/** Delivers one message to the agent's session; resolves with the id of the resulting context message. */
export type MessageSender = (m: AgentMessage) => Promise<{ id: string }>
/** Checked before each send; a string is the refusal reason (e.g. "submitted"). */
export type MessageGuard = () => Promise<RefusalReason | undefined>

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message)
  return String(e)
}

function clipText(s: string): string {
  return s.length > RECORD_TEXT_CHARS ? `${s.slice(0, RECORD_TEXT_CHARS - 1)}…` : s
}

export class AgentMailbox {
  private _state: MailboxState = "pending"
  private readonly entries: MessageRecord[] = []
  private held: AgentMessage[] = []
  private deferred: { msg: AgentMessage; resolve: (r: PostResult) => void }[] = []
  private readonly inflight = new Set<Promise<unknown>>()
  private windowSent: SentMessage[] = []
  private reserved = 0
  private send?: MessageSender
  private guard?: MessageGuard
  private readonly onChange?: () => void

  constructor(opts: { onChange?: () => void } = {}) {
    this.onChange = opts.onChange
  }

  get state(): MailboxState {
    return this._state
  }

  /** Snapshot copies of every message this agent got (held, sent, delivered, …). */
  records(): MessageRecord[] {
    return this.entries.map((e) => ({ ...e }))
  }

  /** Messages accepted so far (held, sent, delivered or undelivered), plus sends in flight. */
  accepted(): number {
    return this.entries.filter((e) => e.status !== "refused").length + this.reserved
  }

  post(msg: AgentMessage): Promise<PostResult> {
    const text = msg.text ?? ""
    if (!text.trim() || text.length > MAX_MESSAGE_CHARS) {
      return Promise.resolve({ ok: false, reason: "limit", detail: `the text must be 1 to ${MAX_MESSAGE_CHARS} characters` })
    }
    switch (this._state) {
      case "closed":
        return Promise.resolve({ ok: false, reason: "finished" })
      case "finishing":
        return Promise.resolve({ ok: false, reason: "finishing" })
    }
    if (this.accepted() >= MAX_MESSAGES_PER_AGENT) {
      return Promise.resolve({ ok: false, reason: "limit", detail: `an agent accepts at most ${MAX_MESSAGES_PER_AGENT} messages` })
    }
    if (this._state === "pending") {
      if (this.held.length >= MAX_HELD_MESSAGES) {
        return Promise.resolve({ ok: false, reason: "limit", detail: `a queued agent holds at most ${MAX_HELD_MESSAGES} messages` })
      }
      this.held.push(msg)
      this.entries.push(this.entryOf(msg, "held"))
      this.changed()
      return Promise.resolve({ ok: true, state: "held" })
    }
    // between or open: the slot is reserved now, so concurrent posts respect the limit.
    this.reserved++
    if (this._state === "between") {
      return new Promise((resolve) => this.deferred.push({ msg, resolve }))
    }
    return this.dispatch(msg)
  }

  /**
   * Runner side: the agent has a session. Returns the held messages (to append to the first
   * prompt; report them delivered once it is sent) and moves to `between`.
   */
  attach(send: MessageSender, guard?: MessageGuard): AgentMessage[] {
    this.send = send
    this.guard = guard
    if (this._state === "pending") this._state = "between"
    const held = this.held
    this.held = []
    return held
  }

  /** Runner side: a turn's prompt has been sent; messages go out right away until close(). */
  open(): void {
    if (this._state === "closed") return
    this._state = "open"
    const waiting = this.deferred
    this.deferred = []
    for (const d of waiting) void this.dispatch(d.msg).then(d.resolve)
  }

  /**
   * Runner side: the turn finished. New messages are refused (`finishing`) until the next open().
   * Resolves, once every send started in this window has settled, with the messages sent in it.
   */
  async close(): Promise<SentMessage[]> {
    if (this._state !== "closed") this._state = "finishing"
    while (this.inflight.size) await Promise.all([...this.inflight])
    const sent = this.windowSent
    this.windowSent = []
    return sent
  }

  /** Runner side: confirms (or not) that a held or sent message reached the agent. */
  report(id: string, status: "delivered" | "undelivered"): void {
    const e = this.entries.find((x) => x.id === id)
    if (!e || (e.status !== "held" && e.status !== "sent")) return
    e.status = status
    this.changed()
  }

  /** The agent settled (or was stopped): every later message is refused with `finished`. */
  seal(): void {
    this._state = "closed"
    const waiting = this.deferred
    this.deferred = []
    for (const d of waiting) {
      this.reserved--
      d.resolve({ ok: false, reason: "finished" })
    }
    this.held = []
  }

  private dispatch(msg: AgentMessage): Promise<PostResult> {
    const p = (async (): Promise<PostResult> => {
      try {
        const refusal = this.guard ? await this.guard().catch(() => undefined) : undefined
        if (refusal) return { ok: false, reason: refusal }
        if (!this.send) return { ok: false, reason: "finished" }
        let res: { id: string }
        try {
          res = await this.send(msg)
        } catch (e) {
          const detail = errText(e)
          this.entries.push({ ...this.entryOf(msg, "refused"), error: detail })
          this.changed()
          return { ok: false, reason: "send_failed", detail }
        }
        const deliveryId = String(res?.id ?? "")
        this.entries.push(this.entryOf(msg, "sent"))
        this.windowSent.push({ id: msg.id, deliveryId })
        this.changed()
        return { ok: true, state: "sent", deliveryId }
      } finally {
        this.reserved--
      }
    })()
    this.inflight.add(p)
    void p.then(() => this.inflight.delete(p))
    return p
  }

  private entryOf(msg: AgentMessage, status: MessageStatus): MessageRecord {
    return { id: msg.id, from: msg.from, via: msg.via, urgent: !!msg.urgent, at: msg.at, text: clipText(msg.text), status }
  }

  private changed(): void {
    try {
      this.onChange?.()
    } catch {
      // listeners must not break delivery
    }
  }
}
