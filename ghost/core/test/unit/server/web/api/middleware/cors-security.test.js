const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');
const configUtils = require('../../../../../utils/config-utils');

describe('cors.reflectOrigin — security regression (CWE-942)', function () {
    let corsModule, reflectOrigin, req, res, next;

    beforeEach(function () {
        corsModule = rewire('../../../../../../core/server/web/api/middleware/cors');
        // Override allowlist to a known set for deterministic testing
        corsModule.__set__('getAllowlist', () => ['localhost', '127.0.0.1', 'mysite.example']);
        reflectOrigin = corsModule.reflectOrigin;

        req = {method: 'GET', headers: {}};
        res = {
            headers: {},
            setHeader: function (h, v) {
                this.headers[h] = v;
            },
            vary: sinon.spy(),
            sendStatus: sinon.stub()
        };
        next = sinon.spy();
    });

    afterEach(async function () {
        sinon.restore();
        await configUtils.restore();
    });

    it('does not reflect arbitrary attacker origin', function () {
        req.headers.origin = 'https://evil.com';
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined,
            'must not reflect unlisted origin');
        assert.equal(res.headers['Access-Control-Allow-Credentials'], undefined,
            'must not allow credentials for unlisted origin');
        sinon.assert.calledOnce(next);
    });

    it('does not reflect null origin', function () {
        req.headers.origin = 'null';
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
    });

    it('does not reflect malformed origin', function () {
        req.headers.origin = 'not-a-valid-origin';
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
    });

    it('does not reflect subdomain of allowed host', function () {
        // Guards against regex-suffix-match bypasses like evil.mysite.example or mysite.example.evil.com
        req.headers.origin = 'https://evil.mysite.example';
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);

        res.headers = {};
        req.headers.origin = 'https://mysite.example.evil.com';
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
    });

    it('reflects origin when host is on the allow-list', function () {
        req.headers.origin = 'https://mysite.example';
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://mysite.example');
        assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
        sinon.assert.called(res.vary);
    });

    it('reflects localhost origin', function () {
        req.headers.origin = 'http://localhost:2368';
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], 'http://localhost:2368');
    });

    it('sets Vary: Origin when reflecting (cache-poisoning guard)', function () {
        req.headers.origin = 'https://mysite.example';
        reflectOrigin(req, res, next);
        sinon.assert.calledWith(res.vary, 'Origin');
    });

    it('handles OPTIONS preflight without setting headers for unlisted origin', function () {
        req.method = 'OPTIONS';
        req.headers.origin = 'https://evil.com';
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
        sinon.assert.calledWith(res.sendStatus, 200);
    });

    it('calls next() when no origin header is present', function () {
        reflectOrigin(req, res, next);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
        sinon.assert.calledOnce(next);
    });
});
