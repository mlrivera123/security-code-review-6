const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');

describe('Users controller', function () {
    let usersController;

    beforeEach(function () {
        usersController = rewire('../../../../core/server/api/endpoints/users');
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('exportData', function () {
        it('rejects traversal in export format', async function () {
            const fs = {
                readFile: sinon.stub().resolves('noop')
            };

            usersController.__set__('fs', fs);

            await assert.rejects(
                usersController.exportData.query({
                    options: {
                        id: '1',
                        format: '../../package.json'
                    },
                    user: {id: '1'}
                }),
                (err) => {
                    assert.equal(err.errorType, 'ValidationError');
                    assert.equal(err.message, 'Invalid export format');
                    return true;
                }
            );

            sinon.assert.notCalled(fs.readFile);
        });
    });

    describe('uploadProfilePicture', function () {
        it('stores avatars under a generated filename', async function () {
            const fs = {
                mkdir: sinon.stub().resolves(),
                rename: sinon.stub().resolves()
            };
            const models = {
                User: {
                    edit: sinon.stub().resolves({id: '1'})
                }
            };
            const crypto = {
                randomUUID: sinon.stub().returns('uuid')
            };

            usersController.__set__('fs', fs);
            usersController.__set__('models', models);
            usersController.__set__('crypto', crypto);

            const clock = sinon.useFakeTimers(new Date('2026-03-25T12:00:00.000Z'));

            await usersController.uploadProfilePicture.query({
                file: {
                    originalname: '../../evil.png',
                    path: '/tmp/uploaded-file'
                },
                options: {id: '1'},
                user: {id: '1'}
            });

            sinon.assert.calledOnce(fs.mkdir);
            sinon.assert.calledOnce(fs.rename);

            const destinationPath = fs.rename.firstCall.args[1];
            assert.match(destinationPath, /core\/built\/images\/avatars\/1-1742904000000-uuid\.png$/);
            sinon.assert.calledOnceWithExactly(models.User.edit, {
                profile_image: '/content/images/avatars/1-1742904000000-uuid.png'
            }, {id: '1', context: {internal: true}});

            clock.restore();
        });
    });
});
