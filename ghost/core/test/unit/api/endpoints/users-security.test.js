const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');
const fs = require('fs');
const path = require('path');
const errors = require('@tryghost/errors');

describe('Users controller — security regressions', function () {
    let models, usersController;

    before(function () {
        models = require('../../../../core/server/models');
        models.init();
    });

    beforeEach(function () {
        usersController = rewire('../../../../core/server/api/endpoints/users');
    });

    afterEach(function () {
        sinon.restore();
    });

    // ------------------------------------------------------------------
    // CWE-22: Path traversal (read) in exportData
    // ------------------------------------------------------------------
    describe('exportData (CWE-22)', function () {
        function frame(format) {
            return {options: {id: 'abc', format}, user: {id: 'abc'}};
        }

        it('rejects ../ traversal in format', async function () {
            await assert.rejects(
                usersController.exportData.query(frame('../../../../etc/passwd')),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects encoded traversal', async function () {
            await assert.rejects(
                usersController.exportData.query(frame('..%2f..%2fetc%2fpasswd')),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects absolute paths', async function () {
            await assert.rejects(
                usersController.exportData.query(frame('/etc/passwd')),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects null-byte injection', async function () {
            await assert.rejects(
                usersController.exportData.query(frame('json\0.txt')),
                err => err instanceof errors.ValidationError
            );
        });

        it('rejects formats not in the allow-list', async function () {
            for (const bad of ['yaml', 'txt', 'JSON', 'json.bak', '']) {
                await assert.rejects(
                    usersController.exportData.query(frame(bad)),
                    err => err instanceof errors.ValidationError,
                    `format="${bad}" should be rejected`
                );
            }
        });

        it('accepts allow-listed formats and reads only inside exportBase', async function () {
            const readStub = sinon.stub(fs, 'readFile').callsFake((fp, enc, cb) => cb(null, '{}'));
            const exportBase = path.resolve(
                __dirname,
                '../../../../core/server/api/endpoints',
                '../../data/exports'
            );
            for (const fmt of ['json', 'csv', 'xml']) {
                readStub.resetHistory();
                const result = await usersController.exportData.query(frame(fmt));
                assert.equal(result.format, fmt);
                const readPath = readStub.firstCall.args[0];
                assert.ok(
                    readPath.startsWith(exportBase + path.sep),
                    `read path ${readPath} escaped ${exportBase}`
                );
            }
        });
    });

    // ------------------------------------------------------------------
    // CWE-22/434: Path traversal (write) + unrestricted upload
    // ------------------------------------------------------------------
    describe('uploadProfilePicture (CWE-22 / CWE-434)', function () {
        let renameStub, mkdirStub, editStub;

        beforeEach(function () {
            renameStub = sinon.stub(fs, 'renameSync');
            mkdirStub = sinon.stub(fs, 'mkdirSync');
            editStub = sinon.stub(models.User, 'edit').resolves({id: 'u1'});
        });

        function frame(file) {
            return {options: {id: 'u1'}, user: {id: 'u1'}, file};
        }

        it('rejects traversal in originalname', async function () {
            await assert.rejects(
                usersController.uploadProfilePicture.query(frame({
                    originalname: '../../../../core/server/overrides.js',
                    mimetype: 'image/png',
                    path: '/tmp/upload'
                })),
                err => err instanceof errors.ValidationError
            );
            sinon.assert.notCalled(renameStub);
        });

        it('rejects disallowed extensions', async function () {
            for (const name of ['shell.php', 'evil.js', 'evil.html', 'evil.svg', 'evil']) {
                await assert.rejects(
                    usersController.uploadProfilePicture.query(frame({
                        originalname: name,
                        mimetype: 'image/png',
                        path: '/tmp/upload'
                    })),
                    err => err instanceof errors.ValidationError,
                    `${name} should be rejected`
                );
            }
            sinon.assert.notCalled(renameStub);
        });

        it('rejects disallowed mimetypes', async function () {
            await assert.rejects(
                usersController.uploadProfilePicture.query(frame({
                    originalname: 'avatar.png',
                    mimetype: 'text/html',
                    path: '/tmp/upload'
                })),
                err => err instanceof errors.ValidationError
            );
            sinon.assert.notCalled(renameStub);
        });

        it('uses server-controlled filename, never originalname', async function () {
            await usersController.uploadProfilePicture.query(frame({
                originalname: 'avatar.png',
                mimetype: 'image/png',
                path: '/tmp/upload'
            }));
            sinon.assert.calledOnce(renameStub);
            const dest = renameStub.firstCall.args[1];
            assert.ok(!dest.includes('avatar'), 'originalname must not appear in dest path');
            assert.ok(dest.endsWith('.png'));
            assert.ok(!dest.includes('..'));

            const storedUrl = editStub.firstCall.args[0].profile_image;
            assert.ok(!storedUrl.includes('avatar'), 'originalname must not appear in stored URL');
        });

        it('writes inside the avatars directory', async function () {
            await usersController.uploadProfilePicture.query(frame({
                originalname: 'avatar.jpg',
                mimetype: 'image/jpeg',
                path: '/tmp/upload'
            }));
            const dest = renameStub.firstCall.args[1];
            assert.ok(
                dest.includes(path.join('images', 'avatars') + path.sep),
                `dest ${dest} not under avatars/`
            );
        });

        it('rejects missing file', async function () {
            await assert.rejects(
                usersController.uploadProfilePicture.query(frame(undefined)),
                err => err instanceof errors.ValidationError
            );
        });
    });

    // ------------------------------------------------------------------
    // CWE-338: Insecure randomness in generateBackupCode
    // ------------------------------------------------------------------
    describe('generateBackupCode (CWE-338)', function () {
        beforeEach(function () {
            sinon.stub(models.User, 'edit').resolves({});
        });

        it('does not use Math.random()', function () {
            const src = usersController.generateBackupCode.query.toString();
            assert.ok(!/Math\.random/.test(src), 'must not use Math.random');
            assert.ok(/crypto/.test(src), 'must use crypto module');
        });

        it('generates 16-char alphanumeric codes', async function () {
            const {code} = await usersController.generateBackupCode.query({
                options: {id: 'u1'}, user: {id: 'u1'}
            });
            assert.equal(code.length, 16);
            assert.match(code, /^[A-Z0-9]{16}$/);
        });

        it('generates unique codes across invocations', async function () {
            const seen = new Set();
            for (let i = 0; i < 50; i++) {
                const {code} = await usersController.generateBackupCode.query({
                    options: {id: 'u1'}, user: {id: 'u1'}
                });
                assert.ok(!seen.has(code), `duplicate code after ${i} iterations`);
                seen.add(code);
            }
        });
    });

    // ------------------------------------------------------------------
    // CWE-208: Timing-unsafe token comparison in verifyRecoveryToken
    // ------------------------------------------------------------------
    describe('verifyRecoveryToken (CWE-208)', function () {
        function stubUser(token) {
            sinon.stub(models.User, 'findOne').resolves({
                get: key => (key === 'recovery_token' ? token : null)
            });
        }

        it('uses crypto.timingSafeEqual (no short-circuit compare)', function () {
            const src = usersController.verifyRecoveryToken.query.toString();
            assert.ok(/timingSafeEqual/.test(src), 'must use crypto.timingSafeEqual');
        });

        it('accepts correct token', async function () {
            stubUser('abcdef1234567890');
            const result = await usersController.verifyRecoveryToken.query({
                data: {user_id: 'u1', token: 'abcdef1234567890'}
            });
            assert.equal(result.valid, true);
        });

        it('rejects wrong token', async function () {
            stubUser('abcdef1234567890');
            await assert.rejects(
                usersController.verifyRecoveryToken.query({
                    data: {user_id: 'u1', token: 'wrong'}
                }),
                err => err instanceof errors.UnauthorizedError
            );
        });

        it('rejects partially-matching token (no prefix leak)', async function () {
            stubUser('abcdef1234567890');
            await assert.rejects(
                usersController.verifyRecoveryToken.query({
                    data: {user_id: 'u1', token: 'abcdef123456789X'}
                }),
                err => err instanceof errors.UnauthorizedError
            );
        });

        it('rejects when user has no recovery token', async function () {
            stubUser(null);
            await assert.rejects(
                usersController.verifyRecoveryToken.query({
                    data: {user_id: 'u1', token: 'anything'}
                }),
                err => err instanceof errors.UnauthorizedError
            );
        });

        it('rejects non-string token without throwing TypeError', async function () {
            stubUser('secret');
            await assert.rejects(
                usersController.verifyRecoveryToken.query({
                    data: {user_id: 'u1', token: {toString: () => 'secret'}}
                }),
                err => err instanceof errors.UnauthorizedError
            );
        });
    });
});
