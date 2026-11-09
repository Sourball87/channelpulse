---
name: PHO-style Focus drill-down
description: User's requested analytics sidebar behavior and reference
---

The user wants ChannelPulse's left bar to resemble their PHO sidebar, with Focus and Reset and account/SKU drill-downs that automatically filter the analytics. Focus filtering belongs on Explorer.

**Why:** The user requested the familiar PHO workflow, rather than a navigation-only sidebar.

**How to apply:** Keep account and stock selections connected to the shared analytics filters. Support combining dimensions and clearing focus. Do not imply account fields such as territory or manager are available without actual source data.

Keep only Account Code and Stock Code in the Focus sidebar; remove Account Name, Stock Description and Stock Group.

**Why:** The user explicitly requested these simpler code-only controls.

**How to apply:** Use codes for options and selected labels, without name/description sublabels or stock-group drill-downs. Preserve account/stock filtering and Reset.

Stock Code is used to measure stock sell-through per week, meaning units sold per week, not a percentage.

**Why:** The user clarified what they are measuring with Stock Code and explicitly confirmed "Units sold per week".

**How to apply:** Express weekly sell-through in units. Distinguish it from stock on hand, percentage sell-through and weeks of inventory.

The user wants one Dashboard at `/` with the current-week SOH/ST table and a WOI heatmap. WOI windows are 4, 8 or 13 weeks, default 4; missing sales reports are not zero, and no sales is a separate state.

**Why:** The user replaced the separate SOH/Sell Through layout with a Dashboard WOI view and explicitly set the coverage windows and no-sales behavior.

**How to apply:** Keep the Dashboard table independently scrollable. Show WOI under 2 in red, 2 to under 4 amber, 4 through 12 neutral, and over 12 blue. Use actual SOH/ST sales observations for the average, expose coverage, and never represent zero sales as infinite WOI.

Sell Through and Explorer are one Phocas-style Explorer at `/explorer`; `/sell-through` may remain an alias. Selectable dimensions are Category, SKU, Customer, Week; measures are Sold, SOH, WOI, Serials reported and DD sell-in. Drill Category → SKU → Customer, with Week available as an additional dimension.

**Why:** The user requested a unified Explorer instead of a separate Sell Through page.

**How to apply:** Keep Focus account/SKU filters on Explorer. Use actual part categories for its category filter, and keep category editing in Settings.

SKU row order is shared between the Dashboard's SOH/ST table and WOI heatmap, stored centrally for all users, and resettable.

**Why:** The user explicitly rejected browser-local ordering and requested a shared Reset order action.

**How to apply:** Persist the complete SKU order server-side and render both Dashboard tables from it. Do not store SKU order in localStorage.

The customer-by-Stock-Code table should support SOH-only, ST-only and combined ST/SOH subcolumns, with metrics dragged into the table.

**Why:** The user provided a reference with paired metrics under each customer and explicitly chose “Drag metrics into the table.”

**How to apply:** Allow selecting/removing/reordering the displayed measures without changing underlying reports. Keep the separate 12-week ST history available; paired metrics describe the same selected reporting week, not mismatched periods.
