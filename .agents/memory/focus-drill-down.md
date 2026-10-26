---
name: PHO-style Focus drill-down
description: User's requested analytics sidebar behavior and reference
---

The user wants ChannelPulse's left bar to resemble their PHO sidebar, with Focus and Reset and account/SKU drill-downs that automatically filter the analytics.

**Why:** The user requested the familiar PHO workflow, rather than a navigation-only sidebar.

**How to apply:** Keep account and stock selections connected to the shared analytics filters. Support combining dimensions and clearing focus. Do not imply account fields such as territory or manager are available without actual source data.

Keep only Account Code and Stock Code in the Focus sidebar; remove Account Name, Stock Description and Stock Group.

**Why:** The user explicitly requested these simpler code-only controls.

**How to apply:** Use codes for options and selected labels, without name/description sublabels or stock-group drill-downs. Preserve account/stock filtering and Reset.

Stock Code is used to measure stock sell-through per week, meaning units sold per week, not a percentage.

**Why:** The user clarified what they are measuring with Stock Code and explicitly confirmed "Units sold per week".

**How to apply:** Express weekly sell-through in units. Distinguish it from stock on hand, percentage sell-through and weeks of inventory.

Show weekly sell-through (units sold) in the heatmap under Stock Code.

**Why:** The user corrected their earlier choice: "no sorry switch the heatmap under stock code to weekly sell through".

**How to apply:** Use weekly sales for cell values and heatmap colours, not weeks of inventory. Keep Account Code, Stock Code and reporting-week filters connected.

Show weeks across the top with the most recent week first, Stock Codes down the left, and units sold in each cell for the last 12 weeks.

**Why:** The user selected "weeks across the top, SKUs down the left" and "Last 12 weeks", then requested reversing the columns so the most recent week is first.

**How to apply:** Account selection scopes the sales and available Stock Codes to the 12-week history. Use consecutive calendar weeks ending at the reporting selection, not 12 nonconsecutive uploaded weeks. Preserve missing reports as missing, rather than inventing zero sales.

Separate SOH and Sell Through into navigation pages, with Sell Through directly below SOH (the former Dashboard). SOH keeps all current summary cards and shows current-week stock with SKUs down the left and Account Codes across the top. Sell Through contains the Phocas Focus sidebar and the weekly sales heatmap only.

**Why:** After trying a shared Dashboard/Focus toggle, the user said they would rather separate them and put Sell Through underneath the Dashboard/SOH navigation item. They previously confirmed the SOH layout and retention of all summary cards.

**How to apply:** Default to SOH. Open Phocas via the Sell Through navigation entry, not a Dashboard mode toggle. Preserve account/stock/date filters between pages and retain the 12-week newest-first sales matrix. Focus only expands/collapses the sell-through drill controls. Keep stock/WOI summary cards out of Sell Through.
