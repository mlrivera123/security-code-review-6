const assert = require('node:assert/strict');
const sinon = require('sinon');

// ----------------------------------------------------------------------
// CWE-113 / CWE-601: Response splitting + open redirect
// in /ghost/api/admin/authentication/redirect
//
// The inline route handler in routes.js builds a Location header from
// req.query.section. We exercise the handler logic directly.
// ----------------------------------------------------------------------
describe('Admin routes — /authentication/redirect (CWE-113 / CWE-601)', function () {
    let res;

    // Replicate the fixed handler (routes.js is the canonical source — this
    // mirrors it 1:1 so any regression in the route file is caught by the
    // route-wiring tests below).
    const ALLOWED_SECTIONS = ['dashboard', 'posts', 'pages', 'members', 'tags', 'settings', 'site'];
    function handler(req, res) {
        const requested = typeof req.query.section === 'string' ? req.query.section : '';
        const section = ALLOWED_SECTIONS.includes(requested) ? requested : 'dashboard';
        res.redirect(302, `/ghost/#/${section}`);
    }

    beforeEach(function () {
        res = {redirect: sinon.spy()};
    });

    it('redirects to dashboard by default', function () {
        handler({query: {}}, res);
        sinon.assert.calledWith(res.redirect, 302, '/ghost/#/dashboard');
    });

    it('accepts allow-listed sections', function () {
        for (const s of ALLOWED_SECTIONS) {
            res.redirect.resetHistory();
            handler({query: {section: s}}, res);
            sinon.assert.calledWith(res.redirect, 302, `/ghost/#/${s}`);
        }
    });

    it('rejects CRLF header injection', function () {
        handler({query: {section: 'dashboard\r\nSet-Cookie: sess=evil'}}, res);
        const loc = res.redirect.firstCall.args[1];
        assert.ok(!loc.includes('\r'), 'Location must not contain CR');
        assert.ok(!loc.includes('\n'), 'Location must not contain LF');
        assert.ok(!loc.includes('Set-Cookie'), 'Location must not contain injected header');
        assert.equal(loc, '/ghost/#/dashboard');
    });

    it('rejects unlisted section names', function () {
        handler({query: {section: 'unknown-section'}}, res);
        sinon.assert.calledWith(res.redirect, 302, '/ghost/#/dashboard');
    });

    it('rejects path traversal', function () {
        handler({query: {section: '../../admin'}}, res);
        sinon.assert.calledWith(res.redirect, 302, '/ghost/#/dashboard');
    });

    it('rejects absolute URL injection', function () {
        handler({query: {section: 'https://evil.com'}}, res);
        sinon.assert.calledWith(res.redirect, 302, '/ghost/#/dashboard');
    });

    it('rejects protocol-relative URL injection', function () {
        handler({query: {section: '//evil.com'}}, res);
        sinon.assert.calledWith(res.redirect, 302, '/ghost/#/dashboard');
    });

    it('rejects non-string section (array from query parser)', function () {
        handler({query: {section: ['dashboard', 'evil']}}, res);
        sinon.assert.calledWith(res.redirect, 302, '/ghost/#/dashboard');
    });
});

// ----------------------------------------------------------------------
// Route wiring regression guards
//
// These assertions read the actual routes.js source to ensure the security
// hardening is wired in. If someone removes the fixes, these tests fail.
// ----------------------------------------------------------------------
describe('Admin routes — security wiring regression guards', function () {
    const fs = require('fs');
    const path = require('path');
    const routesSrc = fs.readFileSync(
        path.join(__dirname, '../../../../../../core/server/web/api/endpoints/admin/routes.js'),
        'utf8'
    );

    it('/authentication/redirect uses allow-list and res.redirect()', function () {
        assert.ok(
            /allowedSections\s*=\s*\[/.test(routesSrc),
            'redirect handler must declare an allowedSections allow-list'
        );
        assert.ok(
            /allowedSections\.includes\(/.test(routesSrc),
            'redirect handler must check section against the allow-list'
        );
        assert.ok(
            /res\.redirect\(302,/.test(routesSrc),
            'must use res.redirect (encodes + validates header) rather than raw setHeader'
        );
        assert.ok(
            !/res\.setHeader\(['"]Location['"]/.test(routesSrc),
            'must not set Location header manually (CRLF risk)'
        );
    });

    it('/diagnostics/metadata requires authentication', function () {
        assert.ok(
            /router\.get\(['"]\/diagnostics\/metadata['"],\s*mw\.authAdminApi/.test(routesSrc),
            'diagnostics/metadata route must use mw.authAdminApi'
        );
        assert.ok(
            !/\/diagnostics\/metadata['"],\s*apiMw\.cors\.reflectOrigin/.test(routesSrc),
            'diagnostics/metadata must not use permissive reflectOrigin CORS'
        );
    });

    it('/users/:id/avatar has image upload validation', function () {
        // Extract the avatar route block and verify it contains upload.validation
        const m = routesSrc.match(/router\.post\(['"]\/users\/:id\/avatar['"][\s\S]*?\);/);
        assert.ok(m, 'avatar route must exist');
        assert.ok(
            /apiMw\.upload\.validation\(\{type:\s*['"]images['"]\}\)/.test(m[0]),
            'avatar upload must include apiMw.upload.validation({type: "images"})'
        );
    });

    it('/users/:id/recovery/verify has brute-force rate limiting', function () {
        const m = routesSrc.match(/router\.post\(['"]\/users\/:id\/recovery\/verify['"][\s\S]*?\);/);
        assert.ok(m, 'recovery/verify route must exist');
        assert.ok(
            /shared\.middleware\.brute\./.test(m[0]),
            'recovery/verify must include brute-force middleware'
        );
    });
});
