---
name: Private browser-test authentication
description: Authenticate signed-in browser checks without exposing runtime admin credentials.
---

The browser-testing notebook does not share the shell's environment variables.
Keep the admin password in the runtime; do not print it or pass its value into
test instructions. Do not weaken app authentication for a browser check.

**Why:** A signed-in Programs check was initially blocked because the notebook
could not access the existing runtime password. Passing it through chat or tool
output would expose a credential.

**How to apply:** A short-lived, one-request, loopback-only helper can call the
existing login endpoint with the runtime password and forward its genuine
Set-Cookie response to a browser navigation, then close immediately. Keep
credentials and cookies in memory, never log or persist them, and leave the
application's auth routes unchanged. Use the same localhost hostname for that
navigation and the development preview so the real cookie applies.
