const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');
const jwt = require('jsonwebtoken');
const errors = require('@tryghost/errors');

describe('Authentication controller — security regressions', function () {
    let authController;

    beforeEach(function () {
        authController = rewire('../../../../core/server/api/endpoints/authentication');
    });

    afterEach(function () {
        sinon.restore();
    });

    // ------------------------------------------------------------------
    // CWE-347 / CWE-798: JWT algorithm confusion + hardcoded secret
    // ------------------------------------------------------------------
    describe('refreshToken (CWE-347 / CWE-798)', function () {
        function withSecret(secret) {
            authController.__set__('config', {
                get: key => (key === 'admin:jwtSecret' ? secret : undefined)
            });
        }

        it('throws when no secret is configured (no hardcoded fallback)', function () {
            withSecret(undefined);
            const oldEnv = process.env.GHOST_JWT_SECRET;
            delete process.env.GHOST_JWT_SECRET;
            try {
                assert.throws(
                    () => authController.refreshToken.query({data: {token: 'x.y.z'}}),
                    err => err instanceof errors.InternalServerError
                        && /not configured/i.test(err.message)
                );
            } finally {
                if (oldEnv !== undefined) {
                    process.env.GHOST_JWT_SECRET = oldEnv;
                }
            }
        });

        it('rejects tokens with alg=none', function () {
            withSecret('real-server-secret');
            // Unsigned token with alg:none — pre-fix the verifier trusted this header.
            const header = Buffer.from(JSON.stringify({alg: 'none', typ: 'JWT'})).toString('base64url');
            const payload = Buffer.from(JSON.stringify({id: 'admin', role: 'Owner'})).toString('base64url');
            const noneToken = `${header}.${payload}.`;
            assert.throws(
                () => authController.refreshToken.query({data: {token: noneToken}}),
                err => err instanceof errors.UnauthorizedError
            );
        });

        it('rejects tokens signed with a different secret', function () {
            withSecret('real-server-secret');
            const forged = jwt.sign({id: 'u1', role: 'Owner'}, 'attacker-secret', {algorithm: 'HS256'});
            assert.throws(
                () => authController.refreshToken.query({data: {token: forged}}),
                err => err instanceof errors.UnauthorizedError
            );
        });

        it('rejects tokens signed with the old hardcoded fallback secret', function () {
            withSecret('real-server-secret');
            const forged = jwt.sign(
                {id: 'u1', role: 'Owner'},
                'ghost_admin_jwt_secret_2024',
                {algorithm: 'HS256'}
            );
            assert.throws(
                () => authController.refreshToken.query({data: {token: forged}}),
                err => err instanceof errors.UnauthorizedError
            );
        });

        it('does not trust attacker-controlled alg header', function () {
            // Source-level regression guard: verifier must pin algorithm.
            const src = authController.refreshToken.query.toString();
            assert.ok(!/jwt\.decode/.test(src), 'must not pre-decode to read alg');
            assert.ok(!/header\.alg/.test(src), 'must not read alg from token header');
            assert.ok(/algorithms:\s*\[['"]HS256['"]\]/.test(src), 'must pin algorithms to HS256');
        });

        it('accepts valid HS256 token and issues a new one', function () {
            withSecret('real-server-secret');
            const valid = jwt.sign({id: 'u1', role: 'Editor'}, 'real-server-secret', {algorithm: 'HS256'});
            const result = authController.refreshToken.query({data: {token: valid}});
            assert.ok(result.token);
            const decoded = jwt.verify(result.token, 'real-server-secret', {algorithms: ['HS256']});
            assert.equal(decoded.id, 'u1');
            assert.equal(decoded.role, 'Editor');
        });

        it('rejects missing token', function () {
            withSecret('real-server-secret');
            assert.throws(
                () => authController.refreshToken.query({data: {}}),
                err => err instanceof errors.BadRequestError
            );
        });
    });

    // ------------------------------------------------------------------
    // CWE-601: Open redirect in completeSignIn
    // ------------------------------------------------------------------
    describe('completeSignIn (CWE-601)', function () {
        const run = returnTo => authController.completeSignIn.query({data: {returnTo}});

        it('accepts valid /ghost/ relative paths', function () {
            assert.equal(run('/ghost/').redirect, '/ghost/');
            assert.equal(run('/ghost/#/dashboard').redirect, '/ghost/#/dashboard');
            assert.equal(run('/ghost/settings').redirect, '/ghost/settings');
        });

        it('rejects absolute external URLs', function () {
            assert.equal(run('https://evil.com/ghost/').redirect, '/ghost/');
            assert.equal(run('http://attacker.example').redirect, '/ghost/');
        });

        it('rejects protocol-relative URLs', function () {
            assert.equal(run('//evil.com/ghost/').redirect, '/ghost/');
        });

        it('rejects javascript: scheme', function () {
            assert.equal(run('javascript:alert(1)').redirect, '/ghost/');
        });

        it('rejects backslash-normalization tricks', function () {
            assert.equal(run('/ghost/\\evil.com').redirect, '/ghost/');
            assert.equal(run('/\\evil.com').redirect, '/ghost/');
        });

        it('rejects CRLF injection', function () {
            assert.equal(run('/ghost/\r\nSet-Cookie: x=1').redirect, '/ghost/');
        });

        it('rejects paths outside /ghost/', function () {
            assert.equal(run('/admin').redirect, '/ghost/');
            assert.equal(run('/').redirect, '/ghost/');
        });

        it('defaults when returnTo is missing or non-string', function () {
            assert.equal(run(undefined).redirect, '/ghost/');
            assert.equal(run(null).redirect, '/ghost/');
            assert.equal(run({toString: () => 'https://evil.com'}).redirect, '/ghost/');
        });
    });
});
