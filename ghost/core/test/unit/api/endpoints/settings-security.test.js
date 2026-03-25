const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');

describe('Settings controller — security regressions', function () {
    let settingsController;

    beforeEach(function () {
        settingsController = rewire('../../../../core/server/api/endpoints/settings');
    });

    afterEach(function () {
        sinon.restore();
    });

    // ------------------------------------------------------------------
    // CWE-209: Stack trace disclosure in getSystemInfo
    // ------------------------------------------------------------------
    describe('getSystemInfo (CWE-209)', function () {
        it('returns system info on success', function () {
            const result = settingsController.getSystemInfo.query();
            assert.ok(result.platform);
            assert.ok(result.nodeVersion);
            assert.equal(result.trace, undefined);
            assert.equal(result.error, undefined);
        });

        it('does not leak stack trace on failure', function () {
            // Force the try-block to throw by replacing `require` inside the controller
            settingsController.__set__('require', () => {
                const err = new Error('secret internal failure: /srv/ghost/core/server/foo.js:42');
                err.stack = 'Error: secret\n    at /srv/ghost/core/server/foo.js:42:1';
                throw err;
            });

            const result = settingsController.getSystemInfo.query();

            assert.ok(!('trace' in result), 'response must not contain stack trace');
            assert.ok(
                !JSON.stringify(result).includes('/srv/ghost'),
                'response must not leak internal file paths'
            );
            assert.ok(
                !JSON.stringify(result).includes('secret internal failure'),
                'response must not leak raw error message'
            );
            assert.equal(typeof result.error, 'string');
        });

        it('source does not reference err.stack in the response', function () {
            const src = settingsController.getSystemInfo.query.toString();
            assert.ok(!/trace:\s*err\.stack/.test(src), 'must not return err.stack');
        });
    });
});
