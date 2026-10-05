# Dashboard / Assistant accuracy hardening

## Source of truth
Dashboard and Assistant analytics use posted General Ledger data through the `account_reporting_role` view. Account-code prefixes are not used for cash, AR, inventory, AP, or COGS classification.

## Period comparisons
The current month compares month-to-date with the previous month's same elapsed days. Last 90 days compares with the immediately preceding 90-day window. Year-to-date compares with the same elapsed period in the prior year.

## Cash flow
Cash-flow figures are calculated per posted journal as the net movement across semantic Cash/Bank accounts. A journal that only moves money between cash/bank accounts therefore nets to zero instead of appearing as both inflow and outflow. Forecast inputs use completed months only.

## Revenue sources
Revenue source data is based on posted Revenue accounts so the displayed sources reconcile to the Revenue KPI. When net revenue is lower than gross positive sources because of reversals/credits, the dashboard falls back to one reconciled net-revenue bar rather than showing a misleading gross sum.

## PV / OR controls
Payment Voucher and Official Receipt offset lines cannot use Cash/Bank, Inventory, AR, AP, GR/IR, or other control accounts. The same restriction is enforced in the backend even if a client bypasses the picker.

## FIFO
FIFO has explicit active-layer state. FIFO issues block on layer shortage instead of silently falling back to average/reference cost. Once FIFO history exists, changing away from FIFO and later re-entering FIFO is blocked to preserve deterministic historical reversals. Reversals restore the exact lots recorded by the original FIFO issue/receipt.
