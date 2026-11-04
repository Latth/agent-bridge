# Case: {{title}}

- case: {{slug}} · opened by {{role}} on {{date}}
- status: open  <!-- open | investigating | root-caused | fixing | verifying | closed -->
- ball with: <!-- role that must act next -->
- environment: staging

## Symptom
<!-- What is wrong, where it shows (screen / endpoint), since when, for which test user. Expected vs actual. -->

## Evidence
<!-- One line per item, stable ids. Big logs/screens go as message attachments: name the msg id.
E1 (mobile): GET /v2/orders/o_123 → 200 at 2026-11-04T10:31:07Z, req_9c1e: "total": 0, screen shows 0,00 TL (msg_… 0-order.png) -->

## Hypotheses
<!-- H1: … — open | confirmed | ruled out (by whom, with which evidence) -->

## Asks
| id | for | ask | status | answer |
|---|---|---|---|---|
<!-- | A1 | backend | Why is total 0 in E1? Trace req_9c1e through the price calculation. | open | | -->

## Findings
<!-- F1 (backend, answers A1): … evidence: log line / query / commit. Links: E1, H1 -->

## Root cause
<!-- One paragraph: what, where (file:line / table / config), why it produced the symptom. -->

## Fix
<!-- What changes, on which side, commit, deployed to. -->

## Verification
<!-- Who re-checked what, result. -->

## Log
- v1 {{role}}: opened the case
