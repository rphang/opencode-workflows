## USER
use a workflow to audit every file under src/ for bugs: one agent per file returning structured findings, then adversarially verify each finding with an independent skeptic, and report only the confirmed bugs as a short table.

## ASSISTANT → tool call: workflow
```js
export const meta = { name: "src-bug-audit", description: "Audit src files for bugs with adversarial verification", phases: [{ title: "Scan" }, { title: "Verify" }, { title: "Report" }] }

const files = (args && args.files) || []

phase('Scan')
const analyzed = await pipeline(files, (file) => agent(
  `Audit this single file for definite bugs only: ${file}.\n\nReturn JSON matching the schema.\nRules:\n- Report only actual bugs, not style, not hypotheticals.\n- Focus on correctness, runtime errors, off-by-one, async/await mistakes, invalid logic, and edge cases.\n- If no bugs are present, return an empty findings array.`,
  {
    label: file,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              bug: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              evidence: { type: 'string' },
              rationale: { type: 'string' }
            },
            required: ['bug', 'severity', 'evidence', 'rationale']
          }
        }
      },
      required: ['file', 'findings']
    }
  }
))

const findings = analyzed.flatMap((r) => (r && r.findings || []).map((f) => ({ file: r.file, ...f })))

phase('Verify')
const reviewed = await pipeline(findings, (finding) => agent(
  `You are an independent skeptic. Verify whether this reported bug is truly confirmed in ${finding.file}.\n\nReported bug: ${finding.bug}\nSeverity: ${finding.severity}\nEvidence: ${finding.evidence}\nRationale: ${finding.rationale}\n\nReturn JSON only. Confirm only if the bug is real and supported by the code. If uncertain, reject it.`,
  {
    label: finding.file,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confirmed: { type: 'boolean' },
        note: { type: 'string' }
      },
      required: ['confirmed', 'note']
    }
  }
).then((review) => ({ finding, review })))

const confirmed = reviewed.filter((x) => x && x.review.confirmed)

phase('Report')
if (confirmed.length === 0) return 'No confirmed bugs found.'

const lines = [
  '| File | Bug | Severity | Evidence |',
  '|---|---|---|---|',
  ...confirmed.map(({ finding }) => `| ${finding.file} | ${finding.bug} | ${finding.severity} | ${finding.evidence} |`)
]

return lines.join('\n')
```

## TOOL RESULT (returned immediately)
```json
{
  "status": "async_launched",
  "taskId": "task_0mue5ipz10000_a2f1903f",
  "taskType": "local_workflow",
  "runId": "wf_0mue5ipz10000_a2f1903f",
  "workflowName": "src-bug-audit",
  "transcriptDir": "<data-dir>\\opencode\\workflows\\ses_f318094e4ffeQlqLc21h56r477\\wf_0mue5ipz10000_a2f1903f",
  "scriptPath": "<data-dir>\\opencode\\workflows\\ses_f318094e4ffeQlqLc21h56r477\\wf_0mue5ipz10000_a2f1903f\\script.js",
  "summary": "Workflow \"src-bug-audit\" (Audit src files for bugs with adversarial verification) launched in the background as run wf_0mue5ipz10000_a2f1903f. Its result arrives in this session as a task notification when it finishes. END YOUR TURN NOW: tell the user it started and stop. Never call workflow_control status, sleep, or run shell commands to wait for completion (status is only for when the user asks about progress). To iterate later, edit <data-dir>\\opencode\\workflows\\ses_f318094e4ffeQlqLc21h56r477\\wf_0mue5ipz10000_a2f1903f\\script.js and relaunch with scriptPath (plus resumeFromRunId \"wf_0mue5ipz10000_a2f1903f\" to reuse completed agents)."
}
```

## ASSISTANT (end of launch turn)
I’m starting a workflow-based audit and will first enumerate `src/` so each file can get its own analysis pass.
Workflow is going up now: one analyzer agent per `src/` file, then separate skeptics to challenge each reported bug.
Workflow started. I’ll return the confirmed-bugs table when it finishes.

## SYNTHETIC <task-notification> (wakes the session)
```xml
<task-notification>
<task-id>task_0mue5ipz10000_a2f1903f</task-id>
<run-id>wf_0mue5ipz10000_a2f1903f</run-id>
<status>completed</status>
<summary>Dynamic workflow "Audit src files for bugs with adversarial verification" completed</summary>
<result>| File | Bug | Severity | Evidence |
|---|---|---|---|
| src/user.ts | `res.json()` is never awaited, so `data` is a Promise rather than the parsed user object. | high | Line 3: `const data = res.json()` followed by line 4: `return data.name.toUpperCase()`. |
| src/date.ts | `isWeekend` checks for `day === 7`, but `Date.prototype.getDay()` never returns 7 (Sunday is `0`), so Sundays are incorrectly reported as weekdays. | medium | `const day = d.getDay(); return day === 6 || day === 7` |
| src/cart.ts | Loop iterates one past the end of the array and reads `items[items.length]`, which is `undefined` and will throw when accessing `.price`/`.qty`. | high | `for (let i = 0; i <= items.length; i++) sum += items[i].price * items[i].qty` |</result>
<usage>agent_count: 6
tokens: 213592
duration_ms: 18752</usage>
<script-path><data-dir>\opencode\workflows\ses_f318094e4ffeQlqLc21h56r477\wf_0mue5ipz10000_a2f1903f\script.js</script-path>
<transcript-dir><data-dir>\opencode\workflows\ses_f318094e4ffeQlqLc21h56r477\wf_0mue5ipz10000_a2f1903f</transcript-dir>
</task-notification>
```

## ASSISTANT (after notification)
| File | Confirmed bug | Severity |
|---|---|---|
| `src/user.ts` | `res.json()` is not awaited, so `data` is a Promise and `data.name` is invalid. | high |
| `src/date.ts` | `getDay()` never returns `7`, so Sundays are misclassified as weekdays. | medium |
| `src/cart.ts` | Loop runs one past the end of the array and dereferences `undefined`. | high |

## /workflows-style status (run.json)
```json
{
  "status": "completed",
  "agentCount": 6,
  "phases": [
    {
      "title": "Scan",
      "agents": 3,
      "done": 3,
      "tokens": 96530,
      "elapsedMs": 6944
    },
    {
      "title": "Verify",
      "agents": 3,
      "done": 3,
      "tokens": 117062,
      "elapsedMs": 11747
    },
    {
      "title": "Report",
      "agents": 0,
      "done": 0,
      "tokens": 0
    }
  ],
  "usage": {
    "input": 67797,
    "output": 908,
    "reasoning": 503,
    "cacheRead": 144384,
    "cacheWrite": 0,
    "cost": 0.06802605
  },
  "logs": []
}
```

transcriptDir: <data-dir>\opencode\workflows\ses_f318094e4ffeQlqLc21h56r477\wf_0mue5ipz10000_a2f1903f
session: ses_f318094e4ffeQlqLc21h56r477
project: <project>
wall: 47s