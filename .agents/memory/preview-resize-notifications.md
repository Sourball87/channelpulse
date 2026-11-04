---
name: Preview resize notifications
description: Browser resize notifications can become misleading preview error modals.
---

A preview “unknown runtime error” after changing reporting weeks can be a browser ResizeObserver notification, not a failed query or JavaScript exception.

**Why:** Browser testing reproduced this with empty error objects and the message “ResizeObserver loop completed with undelivered notifications.” The preview reporter loses that message and substitutes a generic error modal, even though data and interactions complete correctly.

**How to apply:** Capture the original browser error event before diagnosing a calculation or network failure. Keep any handling restricted to the exact benign notifications in development; preserve native warnings and reporting of genuine exceptions. Do not suppress all unknown errors.
