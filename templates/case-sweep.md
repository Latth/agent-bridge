# Sweep: {{title}}

- case: {{slug}} · opened by {{role}} on {{date}}
- status: sweeping  <!-- sweeping | investigating | fixing | verifying | closed -->
- ball with: <!-- role that must act next -->
- environment: staging
- test user: <!-- id only -->

## Goal and scope
<!-- What to cover (screens, flows, roles), what is out of scope, what "correct" means (spec, old version, web). -->

## Coverage
| area / screen | endpoints seen | status | notes |
|---|---|---|---|
<!-- | Order detail | GET /v2/orders/{id} | anomaly N1 | | -->
<!-- status: todo | ok | anomaly | blocked -->

## Anomalies
<!-- One block per anomaly, stable ids. The UI side fills observed/wire; the backend fills its finding.
### N1: order total shows 0
- seen: Order detail, order o_123, 10:31:07Z
- wire: GET /v2/orders/o_123 → 200, req_9c1e, "total": 0, "items": [2 items, 149.90 each]
- layer guess: backend (the API already sends 0)
- ask (backend): why is total 0 when items sum to 299.80?
- finding: 
- status: open  <!-- open | investigating | root-caused | fixed | verified | not a bug -->
-->

## Asks
| id | for | ask | status | answer |
|---|---|---|---|---|

## Root causes
<!-- RC1 (N1, N3): … where, why. -->

## Fixes and verification
<!-- RC1: commit …, deployed to staging; N1 verified by mobile at … -->

## Log
- v1 {{role}}: opened the sweep
