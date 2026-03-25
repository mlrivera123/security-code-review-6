const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const sinon = require('sinon');
const rewire = require('rewire');

describe('Diagnostics controller', function () {
    let diagnosticsController;

    beforeEach(function () {
        diagnosticsController = rewire('../../../../core/server/api/endpoints/diagnostics');
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('fetchPageMetadata', function () {
        it('fetches metadata via the external request helper', async function () {
            const requestExternal = sinon.stub().resolves({
                body: '<html><head><title>Example</title></head></html>',
                statusCode: 200
            });

            diagnosticsController.__set__('requestExternal', requestExternal);

            const result = await diagnosticsController.fetchPageMetadata.query({data: {url: 'https://example.com'}});

            sinon.assert.calledOnceWithExactly(requestExternal, 'https://example.com/', {responseType: 'text'});
            assert.deepEqual(result, {
                url: 'https://example.com/',
                title: 'Example',
                statusCode: 200
            });
        });

        it('rejects unsupported URL schemes', async function () {
            await assert.rejects(
                diagnosticsController.fetchPageMetadata.query({data: {url: 'file:///etc/passwd'}}),
                (err) => {
                    assert.equal(err.errorType, 'ValidationError');
                    assert.equal(err.message, 'Invalid URL format');
                    return true;
                }
            );
        });
    });

    describe('checkConnectivity', function () {
        it('validates ports before opening a connection', async function () {
            const net = {
                createConnection: sinon.stub()
            };

            diagnosticsController.__set__('net', net);

            await assert.rejects(
                diagnosticsController.checkConnectivity.query({data: {host: 'example.com', port: '443;rm -rf /'}}),
                (err) => {
                    assert.equal(err.errorType, 'ValidationError');
                    assert.equal(err.message, 'Invalid port format');
                    return true;
                }
            );

            sinon.assert.notCalled(net.createConnection);
        });

        it('checks connectivity without invoking a shell', async function () {
            const socket = new EventEmitter();
            socket.setTimeout = sinon.stub();
            socket.destroy = sinon.stub();

            const net = {
                createConnection: sinon.stub().callsFake(() => {
                    process.nextTick(() => socket.emit('connect'));
                    return socket;
                })
            };

            diagnosticsController.__set__('net', net);

            const result = await diagnosticsController.checkConnectivity.query({data: {host: 'example.com', port: '443'}});

            sinon.assert.calledOnceWithExactly(net.createConnection, {host: 'example.com', port: 443});
            assert.deepEqual(result, {
                host: 'example.com',
                port: 443,
                reachable: true,
                output: 'Connected'
            });
        });
    });

    describe('importWidgetConfig', function () {
        it('accepts valid JSON objects', function () {
            const result = diagnosticsController.importWidgetConfig.query({data: {config: '{"title":"Example","enabled":true}'}});

            assert.deepEqual(result, {
                imported: true,
                keys: ['title', 'enabled']
            });
        });

        it('rejects non-JSON input', function () {
            assert.throws(
                () => diagnosticsController.importWidgetConfig.query({data: {config: 'process.exit(1)'}}),
                (err) => {
                    assert.equal(err.errorType, 'ValidationError');
                    assert.equal(err.message, 'config must be valid JSON');
                    return true;
                }
            );
        });
    });
});
