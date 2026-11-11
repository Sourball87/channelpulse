---
name: PHO-style Focus drill-down
description: User's requested analytics sidebar behavior and reference
---

The user wants ChannelPulse's left bar to resemble their PHO sidebar, with Focus and Reset and drill-down filters that automatically filter analytics. It belongs on the dedicated Sell Through page at `/sell-through`; `/explorer` redirects there.

**Why:** The user explicitly restored the earlier standalone Phocas-style Sell Through view.

**How to apply:** Keep selections in shared URL-backed filters, support combining dimensions and Reset, and do not imply account fields such as territory or manager exist without source data.

The Focus sidebar order is Category → Stock Code → Account Code. Categories come from Settings part data and exclude the “HDD & Memory” placeholder; keep code-only account and stock options.

**Why:** The user specified this drill-down order and retained the simpler code-only controls.

**How to apply:** Category narrows the heatmap, serial panel, and Stock Code list; preserve shared URL state, removable chips, and Reset.

Stock Code is used to measure stock sell-through per week, meaning units sold per week, not a percentage.

**Why:** The user clarified what they are measuring with Stock Code and explicitly confirmed "Units sold per week".

**How to apply:** Express weekly sell-through in units. Distinguish it from stock on hand, percentage sell-through and weeks of inventory.

The user wants one Dashboard at `/` with the current-week SOH/ST table and a WOI heatmap. WOI windows are 4, 8 or 13 weeks, default 4; missing sales reports are not zero, and no sales is a separate state.

**Why:** The user replaced the separate SOH/Sell Through layout with a Dashboard WOI view and explicitly set the coverage windows and no-sales behavior.

**How to apply:** Keep the Dashboard table independently scrollable. Show WOI under 2 in red, 2 to under 4 amber, 4 through 12 neutral, and over 12 blue. Use actual SOH/ST sales observations for the average, expose coverage, and never represent zero sales as infinite WOI.

Sell Through is the pre-redesign Phocas-style weekly units-sold heatmap with Stock Code rows, ISO-week columns, serial reconciliation below, and an Excel export of the visible heatmap. In week mode it shows 12 weeks ending at the selected week; in period mode it shows the selected inclusive week range.

**Why:** The user asked to remove the new Explorer layout and restore the earlier page as a separate route.

**How to apply:** Preserve global date, Category, Stock Code, and Account Code filters on `/sell-through`; redirect `/explorer` while keeping its query string.

SKU row order is shared between the Dashboard's SOH/ST table and WOI heatmap, stored centrally for all users, and resettable.

**Why:** The user explicitly rejected browser-local ordering and requested a shared Reset order action.

**How to apply:** Persist the complete SKU order server-side and render both Dashboard tables from it. Do not store SKU order in localStorage.

The customer-by-Stock-Code table should support SOH-only, ST-only and combined ST/SOH subcolumns, with metrics dragged into the table.

**Why:** The user provided a reference with paired metrics under each customer and explicitly chose “Drag metrics into the table.”

**How to apply:** Allow selecting/removing/reordering the displayed measures without changing underlying reports. Keep the separate 12-week ST history available; paired metrics describe the same selected reporting week, not mismatched periods.
