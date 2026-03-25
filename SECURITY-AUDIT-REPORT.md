# Security Audit Report — Ghost Admin API

**Date:** 2026-03-25
**Scope:** `ghost/core/core/server/api/endpoints/*` and `ghost/core/core/server/web/api/*`
**Method:** Static code analysis
**Outcome:** 15 vulnerabilities identified, 15 remediated, 93 regression tests added

---

## Executive Summary

A static security review of the Ghost Admin API extended endpoints uncovered **15 vulnerabilities** across 7 source files, including **4 critical** issues enabling remote code execution, SQL injection, OS command injection, and authentication bypass.

All issues have been remediated in-place with minimal behavioural change, and a regression test suite of **~93 test cases** has been added to prevent reintroduction.

| Severity | Count | Remediated |
|----------|-------|------------|
| Critical | 4 | 4 |
| High | 5 | 5 |
| Medium | 4 | 4 |
| Low | 2 | 2 |
| **Total** | **15** | **15** |

### Risk Profile (Pre-Remediation)

- **Full server compromise** was achievable via three independent critical paths (RCE, command injection, JWT forgery).
- **Complete database exfiltration** was possible via SQL injection.
- **Unauthenticated access** to internal network and cloud metadata (SSRF).
- **Arbitrary file read/write** on the Ghost host filesystem.

---

## Findings & Remediation Detail

### CRITICAL

#### 1. Remote Code Execution via `new Function()`
- **CWE-94** · `diagnostics.js` · `importWidgetConfig`
- **Attack:** `{"config":"require('child_process').execSync('...')"}` → arbitrary code execution as the Ghost process.
- **Fix:** Replaced `new Function('return ' + config)()` with `JSON.parse()` + strict object-type validation.

#### 2. SQL Injection
- **CWE-89** · `members.js` · `searchMembers`
- **Attack:** `?query=' UNION SELECT id,password,... FROM users --` → dump admin credentials.
- **Fix:** Replaced `whereRaw` string concatenation with Knex parameterized `.where()`; added LIKE-wildcard escaping and limit clamping (1–100).

#### 3. OS Command Injection
- **CWE-78** · `diagnostics.js` · `checkConnectivity`
- **Attack:** Unvalidated `port` parameter passed to `exec('nc -zv ... ${port}')` → shell command execution.
- **Fix:** Removed `child_process` entirely; reimplemented with `net.createConnection()`. Strict integer port validation (1–65535).

#### 4. JWT Algorithm Confusion + Hardcoded Secret
- **CWE-347 / CWE-798** · `authentication.js` · `refreshToken`
- **Attack:** (a) Token with `alg:none` accepted because verifier trusted attacker-controlled header. (b) Fallback secret `'ghost_admin_jwt_secret_2024'` allowed anyone to forge admin tokens.
- **Fix:** Pinned algorithm server-side to `['HS256']`; removed `jwt.decode()` pre-inspection; removed hardcoded fallback — throws `InternalServerError` if secret unconfigured.

---

### HIGH

#### 5. Server-Side Request Forgery
- **CWE-918** · `diagnostics.js` · `fetchPageMetadata`
- **Attack:** Unauthenticated `?url=http://169.254.169.254/...` → AWS IMDS credential theft, internal network scanning.
- **Fix:** Added `mw.authAdminApi` to route; enforce `http(s)` scheme; DNS-resolve and block RFC1918/loopback/link-local/ULA ranges; `redirect: 'error'`; 5s timeout.

#### 6. Path Traversal (Read)
- **CWE-22** · `users.js` · `exportData`
- **Attack:** `?format=../../../../etc/passwd` → arbitrary file read.
- **Fix:** Strict allow-list `['json', 'csv', 'xml']`; any other value rejected before filesystem access.

#### 7. Path Traversal (Write) + Unrestricted Upload
- **CWE-22 / CWE-434** · `users.js` · `uploadProfilePicture`
- **Attack:** `originalname: '../../../core/server/overrides.js'` → overwrite application code; or upload `.php`/`.js` to a served directory.
- **Fix:** Server-controlled filename `${userId}-${timestamp}${ext}`; extension + MIME allow-list (PNG/JPEG/GIF/WebP); `startsWith(uploadDir)` containment check; added `upload.validation({type:'images'})` middleware.

#### 8. HTTP Response Splitting + Open Redirect
- **CWE-113 / CWE-601** · `routes.js` · `/authentication/redirect`
- **Attack:** `?section=dashboard%0D%0ASet-Cookie:...` → header injection; crafted fragments aid phishing.
- **Fix:** Allow-list of known admin sections; switched to `res.redirect()` (auto-encodes headers).

#### 9. Prototype Pollution
- **CWE-1321** · `members.js` · `updatePreferences`
- **Attack:** `{"preferences":{"__proto__":{"isAdmin":true}}}` → global `Object.prototype` pollution, possible auth bypass.
- **Fix:** `deepMerge` skips `__proto__`/`constructor`/`prototype` keys; added `hasOwnProperty` guard; validates input is plain object.

---

### MEDIUM

#### 10. Regular Expression Denial of Service
- **CWE-1333** · `diagnostics.js` · `validateDisplayName`
- **Attack:** Unauthenticated `?name=aaaa...aaaa!` (≈30 chars) → catastrophic backtracking blocks event loop for seconds.
- **Fix:** Rewrote `/^([a-zA-Z]+\s?)+$/` → `/^[a-zA-Z]+( [a-zA-Z]+)*$/` (linear-time, unambiguous); 191-char length cap.

#### 11. Permissive CORS with Credentials
- **CWE-942** · `cors.js` · `reflectOrigin`
- **Attack:** Any origin reflected with `Allow-Credentials: true` → malicious sites can make authenticated cross-origin requests and read responses.
- **Fix:** Validate origin against `getAllowlist()` (site + admin hosts) before reflecting; added `Vary: Origin`.

#### 12. Cryptographically Weak PRNG
- **CWE-338** · `users.js` · `generateBackupCode`
- **Attack:** `Math.random()` is predictable; 8-char code (~41 bits) guessable.
- **Fix:** `crypto.randomInt()` (CSPRNG); increased to 16 chars (~82 bits).

#### 13. Timing-Unsafe Token Comparison
- **CWE-208** · `users.js` · `verifyRecoveryToken`
- **Attack:** `!==` short-circuits → byte-by-byte brute-force via response timing. Unauthenticated, no rate limit.
- **Fix:** `crypto.timingSafeEqual()` on SHA-256 digests (fixed length, no early exit); added `brute.globalBlock` + `brute.userReset` middleware.

---

### LOW

#### 14. Open Redirect (API Response)
- **CWE-601** · `authentication.js` · `completeSignIn`
- **Attack:** Returns attacker-supplied `returnTo` URL → phishing if client blindly follows.
- **Fix:** Accept only relative paths starting `/ghost/`; reject `//`, `\`, CR/LF.

#### 15. Stack Trace Disclosure
- **CWE-209** · `settings.js` · `getSystemInfo`
- **Attack:** Error path returns `err.stack` (file paths, dependency versions) → reconnaissance aid.
- **Fix:** Log server-side via `@tryghost/logging`; return generic message only.

---

## Changed Files

### Source (7 files, +191 / −43)
```
ghost/core/core/server/api/endpoints/authentication.js
ghost/core/core/server/api/endpoints/diagnostics.js
ghost/core/core/server/api/endpoints/members.js
ghost/core/core/server/api/endpoints/settings.js
ghost/core/core/server/api/endpoints/users.js
ghost/core/core/server/web/api/endpoints/admin/routes.js
ghost/core/core/server/web/api/middleware/cors.js
```

### Tests (7 new files, ~93 test cases)
```
ghost/core/test/unit/api/endpoints/authentication-security.test.js
ghost/core/test/unit/api/endpoints/diagnostics-security.test.js
ghost/core/test/unit/api/endpoints/members-security.test.js
ghost/core/test/unit/api/endpoints/settings-security.test.js
ghost/core/test/unit/api/endpoints/users-security.test.js
ghost/core/test/unit/server/web/api/admin/routes-security.test.js
ghost/core/test/unit/server/web/api/middleware/cors-security.test.js
```

---

## Regression Test Strategy

Each vulnerability is covered by three layers:

1. **Exploit rejection** — original attack payload is submitted and must fail safely.
2. **Happy path** — legitimate input continues to work post-fix.
3. **Structural guard** — source-level assertions (e.g. `!/Math\.random/`, `/timingSafeEqual/`, `!/whereRaw/`) catch silent reverts.

The route-wiring tests read `routes.js` directly to verify middleware (auth, brute-force, upload validation) remains attached.

### Running the Suite
```bash
cd ghost/core
yarn test:single test/unit/api/endpoints/diagnostics-security.test.js
yarn test:single test/unit/api/endpoints/users-security.test.js
yarn test:single test/unit/api/endpoints/members-security.test.js
yarn test:single test/unit/api/endpoints/authentication-security.test.js
yarn test:single test/unit/api/endpoints/settings-security.test.js
yarn test:single test/unit/server/web/api/middleware/cors-security.test.js
yarn test:single test/unit/server/web/api/admin/routes-security.test.js
```

---

## Recommendations

1. **Deploy immediately** — the four critical issues are trivially exploitable.
2. **Rotate secrets** — any JWT issued while the hardcoded fallback was active should be treated as compromised; force re-authentication.
3. **Audit logs** — review access logs for the vulnerable endpoints (`/diagnostics/*`, `/members/search`, `/authentication/token/refresh`) for exploitation indicators.
4. **Configure `admin:jwtSecret`** — the refresh endpoint now hard-fails without it.
5. **CI enforcement** — add the `*-security.test.js` suite as a required PR check.
6. **SAST integration** — consider CodeQL/Semgrep rules for `new Function`, `exec`, `whereRaw`, `Math.random`-for-secrets, and `!==`-token-compare to catch these classes pre-merge.

---

*Report generated by static analysis. No runtime exploitation was performed.*
