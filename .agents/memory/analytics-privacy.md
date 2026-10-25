---
name: Analytics privacy
description: Scope of ChannelPulse custom event payloads
---

Keep custom analytics event properties to counts, UI dimensions, and fixed action/status labels; exclude filenames, account/SKU identities, inventory quantities, prices, and free-form input.

**Why:** Analytics should measure product use without copying commercially sensitive channel data into event payloads.

**How to apply:** Instrument explicit user actions and successful outcomes, not render effects or state rehydration. Do not add account or product identifiers to drill-down events.
