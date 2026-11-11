---
name: Production host access
description: Accessing this deployment when the workspace shell cannot resolve the primary custom domain.
---

When the primary production custom domain fails DNS resolution from the workspace shell, check the deployment metadata for an additional published URL and try that URL before concluding the deployed app is unreachable. Verify the alternate URL belongs to the same deployment.

**Why:** The workspace shell could not resolve the custom domain while the deployment's additional `.replit.app` URL reached the same API.

**How to apply:** For production API work, obtain URLs from deployment metadata; use an alternate published URL only after confirming it is listed for this deployment.
